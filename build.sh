# windows包
# PATH="/opt/homebrew/opt/llvm/bin:$PATH" npm run tauri build -- --target x86_64-pc-windows-msvc --runner cargo-xwin
npx tauri build --target x86_64-pc-windows-msvc --runner cargo-xwin

# macos包
npx tauri build
# npm run tauri build
