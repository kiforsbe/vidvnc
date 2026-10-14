using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace VidVnc.Host;

public sealed partial class HostWindow
{
    // The virtual gamepads a stream's device has plugged in (status `gamepads`, from the worker's
    // `pads` reports), drawn as small controllers whose pressed buttons light up, so the owner
    // can see that gamepad input arrives. Updated with the status, once a second.
    sealed class GamepadsVisual : StackPanel
    {
        readonly StackPanel pads = new() { Orientation = Orientation.Horizontal, Spacing = 20 };
        readonly List<GamepadVisual> visuals = new();

        public GamepadsVisual()
        {
            Spacing = HostSpacing.Small;
            Visibility = Visibility.Collapsed;
            Children.Add(Label("Gamepads", 12));
            Children.Add(pads);
        }

        public void Update(JsonElement row)
        {
            var list = row.TryGetProperty("gamepads", out var value) && value.ValueKind == JsonValueKind.Array
                ? value.EnumerateArray().Where(pad => pad.ValueKind == JsonValueKind.Object).Take(4).ToArray()
                : [];
            while (visuals.Count < list.Length) { var visual = new GamepadVisual(); visuals.Add(visual); pads.Children.Add(visual); }
            while (visuals.Count > list.Length) { pads.Children.Remove(visuals[^1]); visuals.RemoveAt(visuals.Count - 1); }
            for (var index = 0; index < list.Length; index++) visuals[index].Update(list[index]);
            Visibility = list.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        }
    }

    sealed class GamepadVisual : StackPanel
    {
        // Bits of the viewer's `buttons` mask, in the browser's standard gamepad layout.
        const int A = 0, B = 1, X = 2, Y = 3, LeftShoulder = 4, RightShoulder = 5, View = 8, Menu = 9,
            LeftStick = 10, RightStick = 11, Up = 12, Down = 13, Left = 14, Right = 15;
        readonly TextBlock title = Label("", 12);
        readonly Canvas canvas = new() { Width = 168, Height = 84 };
        readonly Dictionary<int, Shape> buttons = new();
        readonly Rectangle leftTrigger = new() { Height = 6 }, rightTrigger = new() { Height = 6 };
        readonly Ellipse leftDot = Dot(8), rightDot = Dot(8);
        const double TriggerWidth = 40, StickTravel = 9;

        static Brush Resource(string key) => (Brush)Application.Current.Resources[key];
        static Ellipse Dot(double size) => new() { Width = size, Height = size };

        public GamepadVisual()
        {
            Spacing = 4;
            Children.Add(title);
            Children.Add(canvas);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(this, "Gamepad");
            Outline(new Rectangle { Width = TriggerWidth, Height = 6 }, 8, 0);
            Outline(new Rectangle { Width = TriggerWidth, Height = 6 }, 120, 0);
            Place(leftTrigger, 8, 0); Place(rightTrigger, 120, 0);
            buttons[LeftShoulder] = Outline(new Rectangle { Width = TriggerWidth, Height = 6, RadiusX = 3, RadiusY = 3 }, 8, 10);
            buttons[RightShoulder] = Outline(new Rectangle { Width = TriggerWidth, Height = 6, RadiusX = 3, RadiusY = 3 }, 120, 10);
            buttons[LeftStick] = Outline(new Ellipse { Width = 28, Height = 28 }, 16, 30);
            buttons[RightStick] = Outline(new Ellipse { Width = 28, Height = 28 }, 94, 54);
            Place(leftDot, 26, 40); Place(rightDot, 104, 64);
            buttons[Up] = Outline(new Rectangle { Width = 8, Height = 8 }, 58, 52);
            buttons[Down] = Outline(new Rectangle { Width = 8, Height = 8 }, 58, 72);
            buttons[Left] = Outline(new Rectangle { Width = 8, Height = 8 }, 48, 62);
            buttons[Right] = Outline(new Rectangle { Width = 8, Height = 8 }, 68, 62);
            buttons[View] = Outline(new Ellipse { Width = 8, Height = 8 }, 66, 30);
            buttons[Menu] = Outline(new Ellipse { Width = 8, Height = 8 }, 94, 30);
            buttons[Y] = Outline(new Ellipse { Width = 11, Height = 11 }, 132, 26);
            buttons[X] = Outline(new Ellipse { Width = 11, Height = 11 }, 119, 39);
            buttons[B] = Outline(new Ellipse { Width = 11, Height = 11 }, 145, 39);
            buttons[A] = Outline(new Ellipse { Width = 11, Height = 11 }, 132, 52);
            ActualThemeChanged += (_, _) => Paint();
        }

        Shape Outline(Shape shape, double left, double top)
        {
            shape.StrokeThickness = 1.5;
            Place(shape, left, top);
            return shape;
        }

        void Place(Shape shape, double left, double top)
        {
            Canvas.SetLeft(shape, left); Canvas.SetTop(shape, top);
            canvas.Children.Add(shape);
        }

        int mask;
        double lx, ly, rx, ry, lt, rt;

        static double Number(JsonElement pad, string key, double low, double high) =>
            pad.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number
                ? Math.Clamp(value.GetDouble(), low, high) : 0;

        public void Update(JsonElement pad)
        {
            var index = (int)Number(pad, "index", 0, 3);
            title.Text = $"Player {index + 1}";
            mask = (int)Number(pad, "buttons", 0, 0xFFFF);
            lx = Number(pad, "lx", -1, 1); ly = Number(pad, "ly", -1, 1);
            rx = Number(pad, "rx", -1, 1); ry = Number(pad, "ry", -1, 1);
            lt = Number(pad, "lt", 0, 1); rt = Number(pad, "rt", 0, 1);
            Paint();
        }

        void Paint()
        {
            var lit = Resource("AccentFillColorDefaultBrush");
            var line = Resource("ControlStrongStrokeColorDefaultBrush");
            var off = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
            foreach (var shape in canvas.Children.OfType<Shape>()) shape.Stroke = line;
            foreach (var (bit, shape) in buttons) shape.Fill = (mask & (1 << bit)) != 0 ? lit : off;
            leftTrigger.Fill = rightTrigger.Fill = lit;
            leftTrigger.Stroke = rightTrigger.Stroke = null;
            leftTrigger.Width = TriggerWidth * lt; rightTrigger.Width = TriggerWidth * rt;
            Canvas.SetLeft(rightTrigger, 120 + TriggerWidth * (1 - rt));
            // Sticks: browser axes, so down is positive, as on screen.
            leftDot.Fill = rightDot.Fill = lit; leftDot.Stroke = rightDot.Stroke = null;
            Canvas.SetLeft(leftDot, 26 + lx * StickTravel); Canvas.SetTop(leftDot, 40 + ly * StickTravel);
            Canvas.SetLeft(rightDot, 104 + rx * StickTravel); Canvas.SetTop(rightDot, 64 + ry * StickTravel);
            var pressed = string.Join(", ", buttons.Where(entry => (mask & (1 << entry.Key)) != 0).Select(entry => ButtonName(entry.Key)));
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(this,
                $"{title.Text} gamepad{(pressed.Length > 0 ? $", pressed: {pressed}" : "")}");
        }

        static string ButtonName(int bit) => bit switch
        {
            A => "A", B => "B", X => "X", Y => "Y", LeftShoulder => "left bumper", RightShoulder => "right bumper",
            View => "View", Menu => "Menu", LeftStick => "left stick", RightStick => "right stick",
            Up => "up", Down => "down", Left => "left", _ => "right",
        };
    }
}
