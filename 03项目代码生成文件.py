import os
import re

def main():
    # 输入的 Markdown 文件名
    input_file = '00code.md'
    
    if not os.path.exists(input_file):
        print(f"错误: 找不到 {input_file} 文件。请确保该文件在当前目录下。")
        return

    print(f"正在读取 {input_file} ...")
    with open(input_file, 'r', encoding='utf-8') as f:
        content = f.read()

    # 🚀 终极优化的正则表达式：
    # 1. ([^\n]+) 限制文件名只能匹配到行尾，绝不跨行吞噬下一个文件
    # 2. (?P<ticks>```+) 动态捕获 3 个或更多反引号 (解决 07记忆提取.md 是 4 个反引号的问题)
    # 3. (?P=ticks) 确保结束的反引号数量与开头的完美匹配
    pattern = r'## 📄 文件:\s*([^\n]+)\n.*?(?P<ticks>```+)\w*\n(.*?)\n(?P=ticks)'

    matches = re.finditer(pattern, content, re.DOTALL)

    count = 0
    for match in matches:
        # --- 提取文件名 ---
        raw_path = match.group(1).strip()
        clean_path = raw_path.replace('---', '').strip()

        # --- 提取源代码 (group 2 是反引号块，group 3 是核心代码) ---
        file_content = match.group(3)

        if not clean_path:
            continue

        # 处理目录结构
        dir_name = os.path.dirname(clean_path)
        if dir_name and not os.path.exists(dir_name):
            try:
                os.makedirs(dir_name, exist_ok=True)
            except Exception as e:
                print(f"无法创建目录 {dir_name}: {e}")
                continue

        # 写入文件
        try:
            with open(clean_path, 'w', encoding='utf-8') as f:
                f.write(file_content)
            print(f"✅ 已写入: {clean_path}")
            count += 1
        except Exception as e:
            print(f"❌ 写入失败 {clean_path}: {e}")

    if count == 0:
        print("\n未发现匹配的文件。请检查 markdown 格式是否正确。")
    else:
        print(f"\n--- 任务完成 ---")
        print(f"共计成功生成文件: {count} 个")

        # 文件生成成功后，清空本次任务使用的输入和结果记录文件。
        for cleanup_file in ('00code.md', 'patch.md', 'res.md'):
            try:
                with open(cleanup_file, 'w', encoding='utf-8'):
                    pass
                print(f'已清空 {cleanup_file}')
            except Exception as e:
                print(f'清空文件失败 {cleanup_file}: {e}')

if __name__ == "__main__":
    main()