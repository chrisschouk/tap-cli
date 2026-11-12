# tap approve: ask from the terminal, answer in TAP, watch the result land.
# Needs a build and the fake TAP running:
#   pnpm build && pnpm tsx scripts/demos/approve-server.ts &
#   mkdir -p .demo/bin && printf '#!/bin/sh\nexec node "$(dirname "$0")/../../dist/cli.js" "$@"\n' > .demo/bin/tap && chmod +x .demo/bin/tap
#   vhs scripts/demos/approve.tape
Output .demo/approve.gif
Set FontSize 15
Set Width 1120
Set Height 1040
Set Theme "Catppuccin Mocha"
Set Padding 20
Set CursorBlink false
Set TypingSpeed 45ms
Set WindowBar Colorful
Set WindowBarSize 28
Set BorderRadius 8
Set MarginFill "#0891B2"
Set Margin 30
Env PS1 "$ "

Hide
Type "export PATH=$PWD/.demo/bin:$PATH TAP_URL=http://127.0.0.1:4777 TAP_API_KEY=tap_ak_demo HOME=$(mktemp -d) NIGHT_DRIVE=0b6f7a52-1c1d-4e0a-9d3e-5a1f2c3b4d5e"
Enter
Type "clear"
Enter
Show

Sleep 600ms
Type "tap approve $NIGHT_DRIVE"
Sleep 400ms
Enter
Sleep 2.5s

Down
Sleep 700ms
Type "r"
Sleep 2s
Screenshot .demo/approve-read.png
Sleep 1.5s
Type "r"
Sleep 1s
Screenshot .demo/approve-chooser.png
Sleep 600ms
Up
Sleep 600ms
Enter

Sleep 7s
Sleep 4s
Screenshot .demo/approve.png
Sleep 3s
