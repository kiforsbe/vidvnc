using Microsoft.UI.Xaml;
namespace VidVnc.Host;
public partial class App : Application
{
    private Window? window;
    public App()
    {
        InitializeComponent();
        // Keep the crash, but leave a record of what caused it in the logs folder.
        UnhandledException += (_, e) =>
        {
            try
            {
                var folder = System.IO.Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData), "VidVNC", "logs");
                System.IO.Directory.CreateDirectory(folder);
                System.IO.File.AppendAllText(System.IO.Path.Combine(folder, "host-crash.log"),
                    $"{System.DateTimeOffset.Now:O}{System.Environment.NewLine}{e.Exception}{System.Environment.NewLine}{System.Environment.NewLine}");
            }
            catch (System.Exception) { }
        };
    }
    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        window = new HostWindow();
        window.Activate();
    }
}
