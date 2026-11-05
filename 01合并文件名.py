import os

# ==========================================
# 用户配置区
# ==========================================
# 在这里设置你需要排除的目录名（精准匹配）
EXCLUDE_DIRS = [
    '.git',
    '__pycache__',
    'node_modules',
    'venv',
    '.idea',
    '.vscode'
]

# 输出的文件名
OUTPUT_FILE = 'path.md'
# ==========================================

def generate_file_tree():
    # 获取当前运行脚本的绝对路径
    base_dir = os.getcwd()

    # 使用 utf-8 编码打开/创建 Markdown 文件
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write("# 文件夹及文件列表\n\n")

        # os.walk 会自顶向下遍历目录树
        for root, dirs, files in os.walk(base_dir):
            # [关键] 原地修改 dirs 列表，剔除在 exclude_dirs 中的目录
            # 这样 os.walk 就不会继续往下遍历这些被排除的目录了
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]

            # 计算相对路径，用于缩进层级
            rel_path = os.path.relpath(root, base_dir)
            if rel_path == '.':
                level = 0
                f.write("- **[当前目录]/**\n")
            else:
                level = rel_path.count(os.sep)
                indent = '    ' * level
                # 写入目录名（加粗以区分文件）
                f.write(f"{indent}- **{os.path.basename(root)}/**\n")

            # 写入当前目录下的所有文件
            file_indent = '    ' * (level + 1)
            for file in files:
                # 建议：跳过生成的 path.md 文件本身和脚本文件自身
                if file == OUTPUT_FILE or file == os.path.basename(__file__):
                    continue
                f.write(f"{file_indent}- {file}\n")

if __name__ == '__main__':
    print("开始扫描目录...")
    generate_file_tree()
    print(f"✅ 扫描完成！目录及文件列表已成功输出到当前目录下的 '{OUTPUT_FILE}' 中。")