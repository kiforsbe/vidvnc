using Microsoft.UI.Xaml;
namespace VidVnc.Host;
public partial class App : Application
{
    private Window? window;
    public App() { InitializeComponent(); }
    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        window = new HostWindow();
        window.Activate();
    }
}
