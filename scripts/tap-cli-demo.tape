Output tap-cli-demo.gif
Require $TAP_API_KEY
Set FontSize 14
Set Shell "bash"
Set Width 800
Set Height 500
Set Padding 32
Set Theme "Dracula"

Type "npm install -g @totalaudiopromo/tap-cli"
Sleep 1s
Enter
Sleep 2s

Type "tap auth login"
Sleep 1s
Enter
Sleep 1s
Type "tap_ak_live_..."
Sleep 2s
Enter
Sleep 2s

Type "clear"
Enter
Type "tap campaigns list"
Sleep 1s
Enter
Sleep 3s

Type "tap stats"
Sleep 1s
Enter
Sleep 3s

Type "tap queue"
Sleep 1s
Enter
Sleep 3s

Type "exit"
Sleep 500ms
Enter