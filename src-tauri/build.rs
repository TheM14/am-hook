fn main() {
    // 图标换了要重新生成 Windows 资源，否则 exe / 安装包里的图标会一直是旧的
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    tauri_build::build()
}
