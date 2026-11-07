
## Which download should I choose?

Choose from the assets attached to this release. The version number in the file name changes with each release; a Windows-only release may not include Mac packages. Portable Windows builds are no longer published: use the installer.

| Your computer | Download | How to use it |
| --- | --- | --- |
| **Windows 10 / 11 (x64)** | `unimux-Setup-<version>.exe` | **Recommended installer.** Installs the app and creates shortcuts. Installed builds support automatic updates. |
| **Mac with Apple Silicon** - M1, M2, M3, M4 or newer | `unimux-<version>-mac-arm64.dmg` | **Recommended for Apple Silicon.** Open the DMG and drag unimux into Applications. |
| **Mac with an Intel processor** | `unimux-<version>-mac-x64.dmg` | **Recommended for Intel Macs.** Open the DMG and drag unimux into Applications. |
| **Mac, ZIP alternative** | `unimux-<version>-mac-arm64.zip` or `…-mac-x64.zip` | Extract the ZIP and move the app into Applications. Choose the same architecture as above. |

On a Mac, open **Apple menu → About This Mac**: **Chip: Apple M…** means Apple Silicon (`arm64`); **Processor: Intel…** means Intel (`x64`). Installed Mac builds can apply updates in place when the app folder is writable and macOS permits replacing the app. Otherwise, download the matching DMG or ZIP and replace the app manually.

The app is unsigned on Windows; macOS packages use an ad-hoc signature and are not notarized. Windows may show SmartScreen; macOS may require **System Settings → Privacy & Security → Open Anyway**.

`latest.yml`, `latest-mac.yml`, `latest.json` and the `.sig` files are update metadata, not installers; `unimux-<version>-mac-<arch>.app.tar.gz` is the archive installed Mac builds update from. `SHA256SUMS.txt` contains download checksums.
