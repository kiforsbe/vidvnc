# macOS host prototype screenshots

Light and dark images of each section of the macOS host UI prototype
([apps/macos-host/Prototype/](../../../apps/macos-host/README.md#ui-prototype)). The
prototype is illustrative: it runs on fake data with no server, and every computer name,
address, device, display and network shown here is sample data. These images show the
planned design, not implemented VidVNC functionality.

Regenerate them from the repository root with:

```sh
apps/macos-host/Prototype/screenshots.sh
```

The script starts the app in the "Local network" scenario (pass another Scenario menu
title as its argument) and the app draws its own window, so no Screen Recording permission
is needed. Because of that, the images show the detail column only: the sidebar's glass
can't be drawn offscreen. Switches are also drawn without their coloured track. Run the
app to see the sidebar, its sharing footer, the menu bar extra, sheets and Settings.

| Section     | Light                                          | Dark                                         |
| ----------- | ---------------------------------------------- | -------------------------------------------- |
| Overview    | [overview-light.png](overview-light.png)       | [overview-dark.png](overview-dark.png)       |
| Connections | [connections-light.png](connections-light.png) | [connections-dark.png](connections-dark.png) |
| Access      | [access-light.png](access-light.png)           | [access-dark.png](access-dark.png)           |
| Network     | [network-light.png](network-light.png)         | [network-dark.png](network-dark.png)         |
| Activity    | [activity-light.png](activity-light.png)       | [activity-dark.png](activity-dark.png)       |
| Displays    | [displays-light.png](displays-light.png)       | [displays-dark.png](displays-dark.png)       |
| Permissions | [permissions-light.png](permissions-light.png) | [permissions-dark.png](permissions-dark.png) |
