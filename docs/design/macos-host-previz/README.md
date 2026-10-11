# macOS host screenshots

Light and dark images of each section of the VidVNC app for Mac
([apps/macos-host](../../../apps/macos-host/README.md)), drawn by the app's own views from
the sample data of a Debug build (`-scenario`), with no server behind them. Every computer
name, address, device, display and network shown here is sample data. They started as the
design preview for plan task 5.1 and are regenerated from the app as it changes.

Regenerate them from the repository root with:

```sh
apps/macos-host/screenshots.sh
```

The script starts the app in the "Local network" scenario (pass another Scenario menu
title as its argument) and the app draws its own window, so no Screen Recording permission
is needed. Because of that, the images show the detail column only: the sidebar's glass
can't be drawn offscreen. Switches are also drawn without their coloured track. Run the
app to see the sidebar, its sharing footer, the menu bar item, sheets and Settings.

| Section     | Light                                          | Dark                                         |
| ----------- | ---------------------------------------------- | -------------------------------------------- |
| Overview    | [overview-light.png](overview-light.png)       | [overview-dark.png](overview-dark.png)       |
| Displays    | [displays-light.png](displays-light.png)       | [displays-dark.png](displays-dark.png)       |
| Streaming   | [streaming-light.png](streaming-light.png)     | [streaming-dark.png](streaming-dark.png)     |
| Connections | [connections-light.png](connections-light.png) | [connections-dark.png](connections-dark.png) |
| Access      | [access-light.png](access-light.png)           | [access-dark.png](access-dark.png)           |
| Network     | [network-light.png](network-light.png)         | [network-dark.png](network-dark.png)         |
| Activity    | [activity-light.png](activity-light.png)       | [activity-dark.png](activity-dark.png)       |
| Permissions | [permissions-light.png](permissions-light.png) | [permissions-dark.png](permissions-dark.png) |
