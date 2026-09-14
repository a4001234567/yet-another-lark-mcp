---
name: stlink-remote
description: Remote STM32 development workflow — compile, flash, and debug via win_exec + ST-Link.
---

# ST-Link Remote Workflow

Remote STM32 development via `win_exec` (frp tunnel to user's Windows machine). The user's Windows has the ARM toolchain, OpenOCD, and a physical ST-Link/V2 connected via USB.

**Prerequisites:**
- `win_exec` available and Windows SSH online
- User has ST-Link/V2 plugged into USB
- `shirosaki` account has necessary permissions (may need `grant.ps1` for some operations)

## 1. Read Source Files

```
win_exec "type C:\\path\\to\\project\\Core\\Src\\main.c"
win_exec "dir /b C:\\path\\to\\project\\Core\\Src\\"
```

## 2. Edit / Write Files

Small edits via PowerShell:
```
win_exec "powershell -Command \"(gc C:\\path\\to\\file.c) -replace 'old', 'new' | sc C:\\path\\to\\file.c\""
```

Full file via base64:
```
base64 /tmp/file | tr -d '\n' > /tmp/file.b64
win_exec "cmd /c echo $(cat /tmp/file.b64)> C:\\Users\\shirosaki\\AppData\\Local\\Temp\\file.b64"
win_exec "certutil -decode C:\\Users\\shirosaki\\AppData\\Local\\Temp\\file.b64 C:\\Users\\shirosaki\\AppData\\Local\\Temp\\file.new"
win_exec "move /y C:\\Users\\shirosaki\\AppData\\Local\\Temp\\file.new C:\\path\\to\\target.c"
```

## 3. Build

```
win_exec "cmd /c set PATH=C:\\msys64\\mingw64\\bin;%PATH% && cd /d C:\\path\\to\\project\\build && ninja -j4"
```

## 4. Flash (OpenOCD)

```
win_exec "cmd /c C:\\msys64\\mingw64\\bin\\openocd.exe -f interface/stlink-v2.cfg -f target/stm32f1x.cfg -c \"program C:/path/to/project/build/firmware.elf verify reset exit\""
```

Adjust target cfg for other MCUs (stm32f4x, stm32g0x, stm32h7x, etc.).

## 5. Debug

```
win_exec "cmd /c start /b C:\\msys64\\mingw64\\bin\\openocd.exe -f interface/stlink-v2.cfg -f target/stm32f1x.cfg"
win_exec "cmd /c C:\\msys64\\mingw64\\bin\\arm-none-eabi-gdb.exe C:\\path\\to\\project\\build\\firmware.elf -ex \"target remote localhost:3333\" -ex \"monitor reset halt\" -ex \"load\""
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `openocd: not found` | Use full path to openocd.exe |
| `access denied` | User runs grant.ps1 |
| `No ST-Link detected` | Re-plug ST-Link USB |
| `arm-none-eabi-gcc: not found` | Set PATH to msys64/mingw64/bin |
