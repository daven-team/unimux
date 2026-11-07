# conpty.dll + OpenConsole.exe 1.23.251008001 (x64)

The ConPTY that unimux 1.2.0 sideloads (package P1, `unimux_pty::conpty`), the same build node-pty 1.1.0 ships in
`third_party/conpty/1.23.251008001/win10-x64` and 1.1.4 used (`useConptyDll`). From Microsoft's Windows Terminal
project (https://github.com/microsoft/terminal, MIT license, text below).

| file | FileVersion | sha256 |
|---|---|---|
| conpty.dll | 1.23.2510.08001 | 7c7430632052ff703540b68371ec43821820aa1335d8e11dfbcd9ff00e9daaed |
| OpenConsole.exe | 1.23.2510.08001 | d1fe7faa62f9e955e2ac2371f95d7e5513df4d496255097158f979c94782c5fc |

Bundled through `bundle.resources` in `src-tauri/crates/unimux-app/tauri.windows.conf.json` to `<install dir>/resources/conpty/x64`
(and copied next to the binary by `cargo build`); the app passes that folder to `ConptyApi::set_resource_dir` at startup.
`UNIMUX_CONPTY_DIR` overrides it; without the files the in-box kernel32 ConPTY is used. arm64 is not built.

To update: copy the two files of a newer node-pty (or a Windows Terminal release's ConPTY NuGet package), update the
table, and run `cargo test -p unimux-pty` (the tests load exactly this folder).

## License (microsoft/terminal)

MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
