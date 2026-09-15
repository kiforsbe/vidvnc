#pragma once
#include <string>
#include <map>
#include <cmath>
inline bool valid_point(double x, double y) {
    return std::isfinite(x) && std::isfinite(y) && x >= 0 && y >= 0 && x <= 1 && y <= 1;
}
inline bool valid_button(int button) { return button >= 0 && button <= 2; }
inline unsigned short key_code(const std::string &code) {
    if (code.size() == 4 && code.substr(0, 3) == "Key" && code[3] >= 'A' && code[3] <= 'Z')
        return code[3];
    if (code.size() == 6 && code.substr(0, 5) == "Digit" && code[5] >= '0' && code[5] <= '9')
        return code[5];
    static const std::map<std::string, int> keys = {{"Enter", 0x0D},
                                                    {"Escape", 0x1B},
                                                    {"Backspace", 8},
                                                    {"Tab", 9},
                                                    {"Space", 0x20},
                                                    {"ShiftLeft", 0xA0},
                                                    {"ShiftRight", 0xA1},
                                                    {"ControlLeft", 0xA2},
                                                    {"ControlRight", 0xA3},
                                                    {"AltLeft", 0xA4},
                                                    {"AltRight", 0xA5},
                                                    {"MetaLeft", 0x5B},
                                                    {"MetaRight", 0x5C},
                                                    {"ArrowLeft", 0x25},
                                                    {"ArrowUp", 0x26},
                                                    {"ArrowRight", 0x27},
                                                    {"ArrowDown", 0x28},
                                                    {"Home", 0x24},
                                                    {"End", 0x23},
                                                    {"PageUp", 0x21},
                                                    {"PageDown", 0x22},
                                                    {"Insert", 0x2D},
                                                    {"Delete", 0x2E},
                                                    {"Minus", 0xBD},
                                                    {"Equal", 0xBB},
                                                    {"BracketLeft", 0xDB},
                                                    {"BracketRight", 0xDD},
                                                    {"Backslash", 0xDC},
                                                    {"Semicolon", 0xBA},
                                                    {"Quote", 0xDE},
                                                    {"Backquote", 0xC0},
                                                    {"Comma", 0xBC},
                                                    {"Period", 0xBE},
                                                    {"Slash", 0xBF},
                                                    {"CapsLock", 0x14},
                                                    {"F1", 0x70},
                                                    {"F2", 0x71},
                                                    {"F3", 0x72},
                                                    {"F4", 0x73},
                                                    {"F5", 0x74},
                                                    {"F6", 0x75},
                                                    {"F7", 0x76},
                                                    {"F8", 0x77},
                                                    {"F9", 0x78},
                                                    {"F10", 0x79},
                                                    {"F11", 0x7A},
                                                    {"F12", 0x7B},
                                                    {"NumLock", 0x90},
                                                    {"Numpad0", 0x60},
                                                    {"Numpad1", 0x61},
                                                    {"Numpad2", 0x62},
                                                    {"Numpad3", 0x63},
                                                    {"Numpad4", 0x64},
                                                    {"Numpad5", 0x65},
                                                    {"Numpad6", 0x66},
                                                    {"Numpad7", 0x67},
                                                    {"Numpad8", 0x68},
                                                    {"Numpad9", 0x69},
                                                    {"NumpadAdd", 0x6B},
                                                    {"NumpadSubtract", 0x6D},
                                                    {"NumpadMultiply", 0x6A},
                                                    {"NumpadDivide", 0x6F},
                                                    {"NumpadDecimal", 0x6E}};
    auto found = keys.find(code);
    return found == keys.end() ? 0 : static_cast<unsigned short>(found->second);
}
