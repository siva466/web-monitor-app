// The app catalog: free apps by winget package id, every id checked against winget's community catalogue on 2026-10-26.
// Chosen to be well known and free (open source, freeware, or free for personal use, which the note says). Left out on purpose: remote-access
// tools, trial or paid software (WinRAR, Docker Desktop), CCleaner, codec packs. This list is the only thing the App catalog page can install.
const CATALOG = [
  {
    name: 'Browsers',
    apps: [
      { id: 'Mozilla.Firefox', name: 'Firefox', note: 'Open-source browser from Mozilla.' },
      { id: 'Google.Chrome', name: 'Google Chrome', note: 'Google\'s browser. Free.' },
      { id: 'Brave.Brave', name: 'Brave', note: 'Chromium browser with a built-in ad blocker.' },
      { id: 'Vivaldi.Vivaldi', name: 'Vivaldi', note: 'Customisable Chromium browser. Free.' },
      { id: 'LibreWolf.LibreWolf', name: 'LibreWolf', note: 'Firefox with privacy settings switched on.' },
      { id: 'TorProject.TorBrowser', name: 'Tor Browser', note: 'Private browsing through the Tor network.' },
    ],
  },
  {
    name: 'Chat and calls',
    apps: [
      { id: 'Discord.Discord', name: 'Discord', note: 'Voice, video and text chat. Free with an account.' },
      { id: 'Telegram.TelegramDesktop', name: 'Telegram', note: 'Messaging app. Open source.' },
      { id: 'OpenWhisperSystems.Signal', name: 'Signal', note: 'Private messaging. Open source.' },
      { id: 'Zoom.Zoom', name: 'Zoom', note: 'Video meetings. Free plan with limits.' },
      { id: 'SlackTechnologies.Slack', name: 'Slack', note: 'Team chat. Free plan with limits.' },
    ],
  },
  {
    name: 'Media',
    apps: [
      { id: 'VideoLAN.VLC', name: 'VLC media player', note: 'Plays almost any video or audio file.' },
      { id: 'mpv.net', name: 'mpv.net', note: 'Small, fast video player.' },
      { id: 'Spotify.Spotify', name: 'Spotify', note: 'Music streaming. Free with ads.' },
      { id: 'OBSProject.OBSStudio', name: 'OBS Studio', note: 'Screen recording and streaming.' },
      { id: 'Audacity.Audacity', name: 'Audacity', note: 'Audio recorder and editor.' },
      { id: 'HandBrake.HandBrake', name: 'HandBrake', note: 'Converts video between formats.' },
      { id: 'ShareX.ShareX', name: 'ShareX', note: 'Screenshots and screen recording with sharing.' },
      { id: 'Greenshot.Greenshot', name: 'Greenshot', note: 'Simple screenshot tool.' },
    ],
  },
  {
    name: 'Graphics and video editing',
    apps: [
      { id: 'GIMP.GIMP.3', name: 'GIMP', note: 'Image editor. Open source.' },
      { id: 'Inkscape.Inkscape', name: 'Inkscape', note: 'Vector graphics editor.' },
      { id: 'KDE.Krita', name: 'Krita', note: 'Digital painting.' },
      { id: 'BlenderFoundation.Blender', name: 'Blender', note: '3D modelling, animation and video editing.' },
      { id: 'KDE.Kdenlive', name: 'Kdenlive', note: 'Video editor. Open source.' },
    ],
  },
  {
    name: 'Documents and notes',
    apps: [
      { id: 'TheDocumentFoundation.LibreOffice', name: 'LibreOffice', note: 'Word processor, spreadsheet and slides.' },
      { id: 'Adobe.Acrobat.Reader.64-bit', name: 'Adobe Acrobat Reader', note: 'Opens and fills in PDFs. Free.' },
      { id: 'SumatraPDF.SumatraPDF', name: 'SumatraPDF', note: 'Light PDF and e-book reader.' },
      { id: 'calibre.calibre', name: 'calibre', note: 'E-book library and converter.' },
      { id: 'Notepad++.Notepad++', name: 'Notepad++', note: 'Text and code editor.' },
      { id: 'Obsidian.Obsidian', name: 'Obsidian', note: 'Linked notes. Free for personal use.' },
      { id: 'Joplin.Joplin', name: 'Joplin', note: 'Note-taking with sync. Open source.' },
    ],
  },
  {
    name: 'Everyday utilities',
    apps: [
      { id: '7zip.7zip', name: '7-Zip', note: 'Opens and makes zip, 7z, rar and more.' },
      { id: 'Microsoft.PowerToys', name: 'PowerToys', note: 'Extra Windows tools from Microsoft.' },
      { id: 'voidtools.Everything', name: 'Everything', note: 'Instant file search by name.' },
      { id: 'KeePassXCTeam.KeePassXC', name: 'KeePassXC', note: 'Offline password manager.' },
      { id: 'Bitwarden.Bitwarden', name: 'Bitwarden', note: 'Password manager with sync. Free plan.' },
      { id: 'qBittorrent.qBittorrent', name: 'qBittorrent', note: 'Torrent client without ads.' },
      { id: 'AutoHotkey.AutoHotkey', name: 'AutoHotkey', note: 'Keyboard shortcuts and small automations.' },
      { id: 'Rufus.Rufus', name: 'Rufus', note: 'Makes bootable USB drives.' },
      { id: 'Balena.Etcher', name: 'balenaEtcher', note: 'Writes disk images to USB drives.' },
    ],
  },
  {
    name: 'PC maintenance and hardware info',
    apps: [
      { id: 'WinDirStat.WinDirStat', name: 'WinDirStat', note: 'Shows what takes up disk space.' },
      { id: 'AntibodySoftware.WizTree', name: 'WizTree', note: 'Very fast disk space viewer. Free for personal use.' },
      { id: 'BleachBit.BleachBit', name: 'BleachBit', note: 'Open-source cleaner for caches and temp files.' },
      { id: 'Klocman.BulkCrapUninstaller', name: 'Bulk Crap Uninstaller', note: 'Removes many programs at once.' },
      { id: 'CPUID.CPU-Z', name: 'CPU-Z', note: 'Shows CPU, memory and board details.' },
      { id: 'CPUID.HWMonitor', name: 'HWMonitor', note: 'Temperatures, voltages and fan speeds.' },
      { id: 'REALiX.HWiNFO', name: 'HWiNFO', note: 'Detailed hardware information. Free for personal use.' },
      { id: 'TechPowerUp.GPU-Z', name: 'GPU-Z', note: 'Graphics card details.' },
      { id: 'CrystalDewWorld.CrystalDiskInfo', name: 'CrystalDiskInfo', note: 'Drive health and temperature.' },
      { id: 'CrystalDewWorld.CrystalDiskMark', name: 'CrystalDiskMark', note: 'Drive speed test.' },
      { id: 'Microsoft.Sysinternals.ProcessExplorer', name: 'Process Explorer', note: 'Advanced task manager from Microsoft.' },
      { id: 'Microsoft.Sysinternals.Autoruns', name: 'Autoruns', note: 'Everything that starts with Windows, from Microsoft.' },
    ],
  },
  {
    name: 'Developer tools',
    apps: [
      { id: 'Git.Git', name: 'Git', note: 'Version control.' },
      { id: 'Microsoft.VisualStudioCode', name: 'Visual Studio Code', note: 'Code editor from Microsoft.' },
      { id: 'GitHub.GitHubDesktop', name: 'GitHub Desktop', note: 'Git with a simple window.' },
      { id: 'Microsoft.WindowsTerminal', name: 'Windows Terminal', note: 'Tabs for PowerShell, cmd and more.' },
      { id: 'Microsoft.PowerShell', name: 'PowerShell 7', note: 'The newer cross-platform PowerShell.' },
      { id: 'OpenJS.NodeJS.LTS', name: 'Node.js (LTS)', note: 'JavaScript runtime with npm.' },
      { id: 'Python.Python.3.14', name: 'Python 3.14', note: 'The Python language.' },
      { id: 'Microsoft.DotNet.SDK.10', name: '.NET SDK 10', note: 'Build .NET apps.' },
      { id: 'GoLang.Go', name: 'Go', note: 'The Go language.' },
      { id: 'Rustlang.Rustup', name: 'Rust (rustup)', note: 'Installer for the Rust toolchain.' },
      { id: 'EclipseAdoptium.Temurin.21.JDK', name: 'Java 21 JDK (Temurin)', note: 'Free, open-source Java development kit.' },
      { id: 'JetBrains.Toolbox', name: 'JetBrains Toolbox', note: 'Manages JetBrains editors. The editors are paid.' },
      { id: 'Postman.Postman', name: 'Postman', note: 'Tests web APIs. Needs an account.' },
      { id: 'DBBrowserForSQLite.DBBrowserForSQLite', name: 'DB Browser for SQLite', note: 'Opens and edits SQLite databases.' },
      { id: 'WinMerge.WinMerge', name: 'WinMerge', note: 'Compares files and folders.' },
      { id: 'WinSCP.WinSCP', name: 'WinSCP', note: 'File transfer over SFTP and SCP.' },
      { id: 'PuTTY.PuTTY', name: 'PuTTY', note: 'SSH client.' },
    ],
  },
  {
    name: 'Games',
    apps: [
      { id: 'Valve.Steam', name: 'Steam', note: 'Game store and library.' },
      { id: 'EpicGames.EpicGamesLauncher', name: 'Epic Games Launcher', note: 'Game store with free weekly games.' },
      { id: 'GOG.Galaxy', name: 'GOG Galaxy', note: 'GOG store and library.' },
      { id: 'Ubisoft.Connect', name: 'Ubisoft Connect', note: 'Needed for Ubisoft games.' },
      { id: 'ElectronicArts.EADesktop', name: 'EA app', note: 'Needed for EA games.' },
      { id: 'Playnite.Playnite', name: 'Playnite', note: 'One library for all your game stores. Open source.' },
    ],
  },
  {
    name: 'Runtimes that other programs need',
    apps: [
      { id: 'Microsoft.VCRedist.2015+.x64', name: 'Visual C++ Redistributable (x64)', note: 'Needed by many programs and games.' },
      { id: 'Microsoft.VCRedist.2015+.x86', name: 'Visual C++ Redistributable (x86)', note: 'The 32-bit version, for older programs.' },
      { id: 'Microsoft.DotNet.DesktopRuntime.8', name: '.NET Desktop Runtime 8', note: 'Runs apps built with .NET 8.' },
      { id: 'Microsoft.DotNet.DesktopRuntime.9', name: '.NET Desktop Runtime 9', note: 'Runs apps built with .NET 9.' },
    ],
  },
];

module.exports = { CATALOG };
