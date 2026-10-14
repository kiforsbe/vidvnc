#include "../src/input-policy.hpp"
#include "../src/host-input-permission.hpp"
#include <cassert>
#include <set>
#ifdef __APPLE__
#include <Carbon/Carbon.h>
#endif
// Both key tables cover exactly the allow-list: a key cannot be allowed on one platform only.
static void same_keys(const std::map<std::string, unsigned short> &table) {
    std::set<std::string> allowed(allowed_key_codes().begin(), allowed_key_codes().end());
    assert(allowed.size() == allowed_key_codes().size());
    std::set<std::string> keys;
    for (const auto &entry : table)
        keys.insert(entry.first);
    assert(keys == allowed);
    // No two keys post the same code.
    std::set<unsigned short> codes;
    for (const auto &entry : table)
        assert(codes.insert(entry.second).second);
}
int main() {
    HostInputPermission permission;
    assert(!permission.allowed(100));
    permission.grant(100, 5000);
    assert(permission.allowed(100));
    assert(permission.allowed(5099));
    assert(!permission.allowed(5100));
    permission.grant(5200, 5000);
    permission.revoke();
    assert(!permission.allowed(5201));
    permission.grant(6000, 0);
    assert(!permission.allowed(6000));
    permission.grant(6000, 6000); // Owner leases cannot exceed the five-second bound.
    assert(!permission.allowed(6000));
    same_keys(windows_key_codes());
    same_keys(macos_key_codes());
    assert(windows_key_codes().at("KeyA") == 0x41);
    assert(windows_key_codes().at("Digit0") == 0x30);
    assert(windows_key_codes().at("ControlRight") == 0xA3);
    assert(macos_key_codes().at("KeyA") == 0x00);
    assert(macos_key_codes().at("MetaLeft") == 0x37);
    assert(!key_code("made-up"));
    assert(!key_code("KeyAA"));
    assert(!key_code(""));
#ifdef __APPLE__
    // The macOS table against the SDK's own names for the same keys.
    const auto &mac = macos_key_codes();
    assert(key_code("KeyA") == kVK_ANSI_A);
    const int letters[] = {kVK_ANSI_A, kVK_ANSI_B, kVK_ANSI_C, kVK_ANSI_D, kVK_ANSI_E, kVK_ANSI_F,
                           kVK_ANSI_G, kVK_ANSI_H, kVK_ANSI_I, kVK_ANSI_J, kVK_ANSI_K, kVK_ANSI_L,
                           kVK_ANSI_M, kVK_ANSI_N, kVK_ANSI_O, kVK_ANSI_P, kVK_ANSI_Q, kVK_ANSI_R,
                           kVK_ANSI_S, kVK_ANSI_T, kVK_ANSI_U, kVK_ANSI_V, kVK_ANSI_W, kVK_ANSI_X,
                           kVK_ANSI_Y, kVK_ANSI_Z};
    for (int i = 0; i < 26; ++i)
        assert(mac.at(std::string("Key") + static_cast<char>('A' + i)) == letters[i]);
    const int digits[] = {kVK_ANSI_0, kVK_ANSI_1, kVK_ANSI_2, kVK_ANSI_3, kVK_ANSI_4,
                          kVK_ANSI_5, kVK_ANSI_6, kVK_ANSI_7, kVK_ANSI_8, kVK_ANSI_9};
    for (int i = 0; i < 10; ++i)
        assert(mac.at("Digit" + std::to_string(i)) == digits[i]);
    assert(mac.at("Enter") == kVK_Return && mac.at("Escape") == kVK_Escape &&
           mac.at("Backspace") == kVK_Delete && mac.at("Delete") == kVK_ForwardDelete &&
           mac.at("Tab") == kVK_Tab && mac.at("Space") == kVK_Space);
    assert(mac.at("ShiftLeft") == kVK_Shift && mac.at("ShiftRight") == kVK_RightShift &&
           mac.at("ControlLeft") == kVK_Control && mac.at("ControlRight") == kVK_RightControl &&
           mac.at("AltLeft") == kVK_Option && mac.at("AltRight") == kVK_RightOption &&
           mac.at("MetaLeft") == kVK_Command && mac.at("MetaRight") == kVK_RightCommand);
    assert(mac.at("ArrowLeft") == kVK_LeftArrow && mac.at("ArrowUp") == kVK_UpArrow &&
           mac.at("ArrowRight") == kVK_RightArrow && mac.at("ArrowDown") == kVK_DownArrow);
    assert(mac.at("Home") == kVK_Home && mac.at("End") == kVK_End &&
           mac.at("PageUp") == kVK_PageUp && mac.at("PageDown") == kVK_PageDown &&
           mac.at("Insert") == kVK_Help);
    assert(mac.at("Minus") == kVK_ANSI_Minus && mac.at("Equal") == kVK_ANSI_Equal &&
           mac.at("BracketLeft") == kVK_ANSI_LeftBracket &&
           mac.at("BracketRight") == kVK_ANSI_RightBracket &&
           mac.at("Backslash") == kVK_ANSI_Backslash && mac.at("Semicolon") == kVK_ANSI_Semicolon &&
           mac.at("Quote") == kVK_ANSI_Quote && mac.at("Backquote") == kVK_ANSI_Grave &&
           mac.at("Comma") == kVK_ANSI_Comma && mac.at("Period") == kVK_ANSI_Period &&
           mac.at("Slash") == kVK_ANSI_Slash && mac.at("CapsLock") == kVK_CapsLock);
    const int functions[] = {kVK_F1, kVK_F2, kVK_F3, kVK_F4,  kVK_F5,  kVK_F6,
                             kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12};
    for (int i = 0; i < 12; ++i)
        assert(mac.at("F" + std::to_string(i + 1)) == functions[i]);
    const int keypad[] = {kVK_ANSI_Keypad0, kVK_ANSI_Keypad1, kVK_ANSI_Keypad2, kVK_ANSI_Keypad3,
                          kVK_ANSI_Keypad4, kVK_ANSI_Keypad5, kVK_ANSI_Keypad6, kVK_ANSI_Keypad7,
                          kVK_ANSI_Keypad8, kVK_ANSI_Keypad9};
    for (int i = 0; i < 10; ++i)
        assert(mac.at("Numpad" + std::to_string(i)) == keypad[i]);
    assert(mac.at("NumLock") == kVK_ANSI_KeypadClear &&
           mac.at("NumpadAdd") == kVK_ANSI_KeypadPlus &&
           mac.at("NumpadSubtract") == kVK_ANSI_KeypadMinus &&
           mac.at("NumpadMultiply") == kVK_ANSI_KeypadMultiply &&
           mac.at("NumpadDivide") == kVK_ANSI_KeypadDivide &&
           mac.at("NumpadDecimal") == kVK_ANSI_KeypadDecimal);
#else
    assert(key_code("KeyA") == 0x41);
#endif
    assert(valid_point(0, 1));
    assert(!valid_point(-0.01, 0));
    assert(!valid_point(NAN, 0));
    assert(!valid_point(0, INFINITY));
    assert(valid_button(0) && valid_button(2));
    assert(!valid_button(3));

    // Gamepads: whole states within range only.
    const PadFields rest{0, 0, 0, 0, 0, 0, 0, 0};
    assert(pad_state(rest));
    const PadFields edges{3, 0xFF3F, -1, 1, 1, -1, 1, 1};
    const auto pad = pad_state(edges);
    assert(pad && pad->index == 3 && pad->buttons == 0xFF3F && pad->left_y == 1);
    const auto rejected = [&](auto change) {
        auto fields = rest;
        change(fields);
        return !pad_state(fields);
    };
    assert(rejected([](PadFields &f) { f.index = 4; }));
    assert(rejected([](PadFields &f) { f.index = -1; }));
    assert(rejected([](PadFields &f) { f.index = 0.5; }));
    assert(rejected([](PadFields &f) { f.index = NAN; }));
    assert(rejected([](PadFields &f) { f.buttons = 1 << 6; }));  // left trigger travels as lt
    assert(rejected([](PadFields &f) { f.buttons = 1 << 7; }));  // right trigger as rt
    assert(rejected([](PadFields &f) { f.buttons = 1 << 16; })); // home is not passed on
    assert(rejected([](PadFields &f) { f.buttons = -1; }));
    assert(rejected([](PadFields &f) { f.buttons = 1.5; }));
    assert(rejected([](PadFields &f) { f.left_x = 1.01; }));
    assert(rejected([](PadFields &f) { f.right_y = -1.01; }));
    assert(rejected([](PadFields &f) { f.left_y = INFINITY; }));
    assert(rejected([](PadFields &f) { f.right_x = NAN; }));
    assert(rejected([](PadFields &f) { f.left_trigger = -0.01; }));
    assert(rejected([](PadFields &f) { f.right_trigger = 1.01; }));
    // Every allowed button maps to exactly one distinct GamepadButtons flag.
    std::set<int> indices;
    std::set<unsigned> flags;
    for (const auto &entry : windows_pad_buttons()) {
        assert(pad_button_mask & (1u << entry.index));
        assert(indices.insert(entry.index).second);
        assert(flags.insert(entry.flag).second);
    }
    unsigned mapped = 0;
    for (auto index : indices)
        mapped |= 1u << index;
    assert(mapped == pad_button_mask);
    PadState state;
    state.buttons = (1u << 0) | (1u << 9) | (1u << 12);
    state.left_y = 0.5; // stick pushed down in the browser...
    state.right_y = -1; // ...and up
    state.left_trigger = 0.25;
    const auto reading = windows_pad_reading(state);
    assert(reading.buttons == (0x4u | 0x1u | 0x40u));       // A, Menu, DPadUp
    assert(reading.left_y == -0.5 && reading.right_y == 1); // Windows has up positive
    assert(reading.left_trigger == 0.25 && reading.right_trigger == 0);
}
