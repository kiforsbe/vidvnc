#pragma once
// The files a program maps when it starts: the program and every library it links, followed
// through its Mach-O load commands (LC_LOAD_DYLIB and the weak, re-export and upward forms,
// with @rpath, @loader_path and @executable_path resolved). The sandbox launcher allows reading
// and mapping exactly their folders (design D3), so a program under the profile can start
// without the profile naming where it was installed. System libraries and programs are left
// out: the profile allows the system's libraries anyway.
#include <mach-o/fat.h>
#include <mach-o/loader.h>
#include <libkern/OSByteOrder.h>
#include <climits>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <set>
#include <string>
#include <vector>

namespace macos {

inline std::string real_path(const std::string &path) {
    char resolved[PATH_MAX];
    return realpath(path.c_str(), resolved) ? std::string(resolved) : std::string();
}

inline std::string parent_folder(const std::string &path) {
    const auto slash = path.find_last_of('/');
    return slash == std::string::npos || slash == 0 ? std::string("/") : path.substr(0, slash);
}

// The sealed system volume: the shared cache's libraries and the system's own programs.
// /usr/local is not part of it.
inline bool in_system(const std::string &path) {
    for (const char *prefix : {"/System/", "/usr/", "/bin/", "/sbin/"})
        if (path.rfind(prefix, 0) == 0)
            return path.rfind("/usr/local/", 0) != 0;
    return false;
}

namespace macho_detail {

struct Commands {
    std::vector<std::string> libraries, rpaths;
};

// The arm64 image's dependent libraries and rpaths, from a thin or universal file. False when
// the file is not a 64-bit arm64 Mach-O image.
inline bool read_commands(const std::string &path, Commands &out) {
    std::ifstream file(path, std::ios::binary);
    if (!file)
        return false;
    std::uint32_t magic = 0;
    file.read(reinterpret_cast<char *>(&magic), sizeof(magic));
    std::uint64_t offset = 0;
    if (magic == FAT_CIGAM || magic == FAT_CIGAM_64) {
        // A universal file: its header is big-endian.
        std::uint32_t count = 0;
        file.read(reinterpret_cast<char *>(&count), sizeof(count));
        count = OSSwapBigToHostInt32(count);
        bool found = false;
        for (std::uint32_t i = 0; i < count && i < 16 && !found; ++i) {
            if (magic == FAT_CIGAM) {
                fat_arch arch{};
                file.read(reinterpret_cast<char *>(&arch), sizeof(arch));
                if (static_cast<cpu_type_t>(OSSwapBigToHostInt32(arch.cputype)) == CPU_TYPE_ARM64) {
                    offset = OSSwapBigToHostInt32(arch.offset);
                    found = true;
                }
            } else {
                fat_arch_64 arch{};
                file.read(reinterpret_cast<char *>(&arch), sizeof(arch));
                if (static_cast<cpu_type_t>(OSSwapBigToHostInt32(arch.cputype)) == CPU_TYPE_ARM64) {
                    offset = OSSwapBigToHostInt64(arch.offset);
                    found = true;
                }
            }
        }
        if (!found || !file)
            return false;
    }
    file.seekg(static_cast<std::streamoff>(offset));
    mach_header_64 header{};
    file.read(reinterpret_cast<char *>(&header), sizeof(header));
    if (!file || header.magic != MH_MAGIC_64 || header.cputype != CPU_TYPE_ARM64 ||
        header.sizeofcmds > (16u << 20))
        return false;
    std::vector<char> commands(header.sizeofcmds);
    file.read(commands.data(), static_cast<std::streamsize>(commands.size()));
    if (!file)
        return false;
    // A string inside a load command, by its offset from the command's start.
    const auto text = [&](std::size_t at, std::uint32_t command_size, std::uint32_t string_at) {
        if (string_at >= command_size)
            return std::string();
        const char *start = commands.data() + at + string_at;
        return std::string(start, strnlen(start, command_size - string_at));
    };
    std::size_t at = 0;
    for (std::uint32_t i = 0; i < header.ncmds; ++i) {
        if (at + sizeof(load_command) > commands.size())
            return false;
        load_command command{};
        std::memcpy(&command, commands.data() + at, sizeof(command));
        if (command.cmdsize < sizeof(load_command) || at + command.cmdsize > commands.size())
            return false;
        switch (command.cmd) {
        case LC_LOAD_DYLIB:
        case LC_LOAD_WEAK_DYLIB:
        case LC_REEXPORT_DYLIB:
        case LC_LOAD_UPWARD_DYLIB: {
            dylib_command library{};
            if (command.cmdsize < sizeof(library))
                return false;
            std::memcpy(&library, commands.data() + at, sizeof(library));
            out.libraries.push_back(text(at, command.cmdsize, library.dylib.name.offset));
            break;
        }
        case LC_RPATH: {
            rpath_command rpath{};
            if (command.cmdsize < sizeof(rpath))
                return false;
            std::memcpy(&rpath, commands.data() + at, sizeof(rpath));
            out.rpaths.push_back(text(at, command.cmdsize, rpath.path.offset));
            break;
        }
        default:
            break;
        }
        at += command.cmdsize;
    }
    return true;
}

inline std::string expand(const std::string &path, const std::string &loader,
                          const std::string &executable) {
    for (const auto &[prefix, folder] :
         {std::pair<std::string, std::string>{"@loader_path", parent_folder(loader)},
          {"@executable_path", parent_folder(executable)}})
        if (path.rfind(prefix, 0) == 0)
            return folder + path.substr(prefix.size());
    return path;
}

struct Walk {
    std::string executable;
    std::set<std::string> seen;
    std::vector<std::string> images, links;

    // `rpaths`: the rpaths in force for this image, its loaders' first, already expanded.
    void visit(const std::string &path, std::vector<std::string> rpaths) {
        const auto real = real_path(path);
        if (real.empty() || in_system(real))
            return;
        // dyld opens the path it was given, through any symbolic links on it.
        if (path != real && seen.insert(path).second)
            links.push_back(path);
        if (!seen.insert(real).second)
            return;
        images.push_back(real);
        Commands commands;
        if (!read_commands(real, commands))
            return;
        // dyld expands @loader_path from the path the image was opened by, not its real path.
        for (const auto &rpath : commands.rpaths)
            rpaths.push_back(expand(rpath, path, executable));
        for (const auto &library : commands.libraries) {
            if (in_system(library))
                continue;
            if (library.rfind("@rpath/", 0) == 0) {
                const auto rest = library.substr(6);
                for (const auto &rpath : rpaths)
                    if (!real_path(rpath + rest).empty()) {
                        visit(rpath + rest, rpaths);
                        break;
                    }
            } else {
                visit(expand(library, path, executable), rpaths);
            }
        }
    }
};

} // namespace macho_detail

struct StartupImages {
    // The real paths of the program and every non-system library it loads at start-up, the
    // program first.
    std::vector<std::string> images;
    // The paths dyld opens them by where those differ (Homebrew's `opt` links, say): the
    // profile must let dyld follow the links on them.
    std::vector<std::string> links;
};

// Libraries that cannot be found are skipped: dyld would then refuse to start the program
// anyway, under the profile or not.
inline StartupImages startup_images(const std::string &program) {
    macho_detail::Walk walk;
    walk.executable = program;
    walk.visit(program, {});
    return {walk.images, walk.links};
}

} // namespace macos
