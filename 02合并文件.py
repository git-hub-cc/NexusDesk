import os
import sys
import subprocess

# --- 配置 ---
# 起始搜索目录（'.' 表示当前目录）
START_DIRECTORY = '.'
# 输出文件名
OUTPUT_FILE = 'res.md'

# 【修改】要排除的文件扩展名 (即黑名单，请使用小写)
# 只要文件的后缀 *不在* 这个列表中，都会被合并
EXCLUDED_EXTENSIONS = [
    # 图片和媒体文件
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.mp3', '.mp4', '.avi', '.mov',
    # 压缩包和二进制文件
    '.zip', '.tar', '.gz', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin',
    # 编译产生的中间文件或字节码
    '.pyc', '.class', '.o', '.obj',
    # 办公文档 (通常无法直接作为纯文本读取)
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    # 系统文件
    '.ds_store',
    # 临时文件
    '.tmp', '.gradle', '.jar', '.log', '.pro',

    '.apk', '.dex', '.ap_', '.flat',  '.lock', '.metainfo', '.ninja',

    '.msi',  '.check_cache', '.cmake', '.qmltypes', '.ttf','.iss', '.ps1', '.d','.jsc','.qmlc',
    '.a', '.lib', '.exp', '.pdb', '.bak', '.cmd', '.db', '.in', '.pri', '.recipe', '.user', '.vsidx',
    '.frag',
    '.fsh',
    '.vsh',
    '.md',
    '.qm',
    '.qrc',
    '.sqlite',
    '.ts_lst_file',
    '.generate',
    '.metagen', '.csv',
    '.svg', '.txt', '.json', '.py', '.onnx'
]

# 行数限制
LINE_LIMIT = 2000
# 要排除的目录名
EXCLUDED_DIRS = [
    # 依赖包与第三方库
    'node_modules', '.venv', 'venv',

    # 版本控制与编辑器配置
    '.git', '.idea', '.vite',

    # 编译输出、构建产物与缓存
    '__pycache__', 'out', 'gen', 'target', 'bin', 'obj',

    # 临时文件与日志
    'tmp', 'temp',

    # 文档、资源与非代码素材
    'docs', 'script', 'combiner',

    'dist', 'build',

    '.svelte-kit',

    'tests', 'build', 'deploy', 'output', 'build_release',
  
    'QXlsx', 'lib', 'common', 'icons' , 'ocr', 'public', '.cargo'
]
# 要排除的特定文件名
EXCLUDED_FILES = ['patch.md','res.md', '.gitignore']
# --- 配置结束 ---

def find_files_recursively(start_dir: str) -> list[str]:
    """
    递归地在目录中查找符合条件的文件。
    """
    target_files = []
    # os.walk 会遍历指定目录下的所有子目录和文件
    for dirpath, dirnames, filenames in os.walk(start_dir):
        # 原地修改 dirnames 列表可以阻止 os.walk 进入这些目录
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS]

        for filename in filenames:
            full_path = os.path.join(dirpath, filename)
            file_ext = os.path.splitext(filename)[1].lower()

            # 核心过滤逻辑：不是输出文件 & 后缀不在黑名单 & 文件名不在排除列表
            if (filename != OUTPUT_FILE and
                    file_ext not in EXCLUDED_EXTENSIONS and
                    filename not in EXCLUDED_FILES):

                target_files.append(os.path.normpath(full_path))

    return target_files

def main():
    # 文件名
    file_path = "patch.md"

    # 检查文件是否存在，避免程序因找不到文件而报错
    if os.path.exists(file_path):
        try:
            os.remove(file_path)
            print(f"成功删除文件: {file_path}")
        except PermissionError:
            print(f"错误：没有权限删除 {file_path}。")
        except Exception as e:
            print(f"发生未知错误: {e}")
    else:
        print(f"文件 {file_path} 不存在，无需删除。")

    """
    主函数，执行文件合并逻辑。
    """
    print('🚀 开始扫描文件 (黑名单模式)...')

    try:
        # 1. 查找所有相关文件
        target_files = find_files_recursively(START_DIRECTORY)

        if not target_files:
            print(f'🤷 在当前目录及子目录中未找到任何符合条件的文件。')
            return

        # ==========================================
        # 【新增功能】 统计并打印所有出现的扩展名 (去重)
        # ==========================================
        found_extensions = set()
        for path in target_files:
            # 获取后缀名
            ext = os.path.splitext(path)[1].lower()
            # 如果没有后缀名（如 .gitignore, Makefile），记录为 '(无后缀)' 方便查看，或者直接存空字符串
            found_extensions.add(ext if ext else "(无后缀)")

        # 排序并打印
        sorted_exts = sorted(list(found_extensions))
        print(f"\n📊 统计到以下文件类型将被处理 (已去重):")
        print(f"   {sorted_exts}")
        print("-" * 40 + "\n")
        # ==========================================

        print(f'🔍 找到了 {len(target_files)} 个文件，准备合并...')

        final_content = []

        # 2. 遍历并处理每个文件
        for file_path in target_files:
            try:
                # 使用 'with' 语句安全地读取文件
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    lines = f.readlines()

                content_to_append = "".join(lines)

                # 3. 检查行数是否超限
                if len(lines) > LINE_LIMIT:
                    print(
                        f"[⚠️ 警告] 文件行数超限: {file_path}\n"
                        f"         总行数: {len(lines)}, 将截取前 {LINE_LIMIT} 行。"
                    )
                    content_to_append = "".join(lines[:LINE_LIMIT])

                # 4. 为每个文件内容添加分隔符和标题
                lang = os.path.splitext(file_path)[1][1:].lower() or 'text'

                file_header = f"\n\n---\n\n## 📄 文件: {file_path}\n\n---\n\n"
                code_block_wrapper = f"```{lang}\n{content_to_append.strip()}\n```"

                final_content.append(file_header + code_block_wrapper)

            except IOError as read_error:
                print(f'❌ 读取文件 {file_path} 失败: {read_error}', file=sys.stderr)
            except Exception as e:
                print(f'❌ 处理文件 {file_path} 时发生未知错误: {e}', file=sys.stderr)


        # 5. 将合并后的内容写入输出文件 (增加目录索引)
        output_path = os.path.join(START_DIRECTORY, OUTPUT_FILE)
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write("# 📚 项目代码合并清单\n\n")
            for i, p in enumerate(target_files, 1):
                anchor = p.replace('\\', '/')
                f.write(f"{i}. [{p}](#-文件-{anchor})\n")
            f.write("\n" + "".join(final_content))

        print(f'\n✅ 操作成功!')
        print(f'   - 合并了 {len(target_files)} 个文件。')
        print(f'   - 输出文件已保存至: {os.path.abspath(output_path)}')


        # 执行git命令
        try:
            print('🚀 正在导出最近一次提交的 patch...')
            # 1. 运行 git 命令，捕获 stdout 输出 (不再使用 shell 重定向)
            result = subprocess.run(
                ["git", "format-patch", "-1", "HEAD", "--stdout"],
                capture_output=True,
                check=True
            )

            # 2. 将捕获到的字节流以 UTF-8 编码写入文件
            # 如果 git 输出包含非 utf-8 字符（如旧代码的注释），使用 errors='ignore' 或 'replace'
            patch_content = result.stdout.decode('utf-8', errors='ignore')

            with open("patch.md", "w", encoding="utf-8") as f:
                f.write(patch_content)

            print('✅ patch.md 生成成功 (强制 UTF-8 编码)!')
        except subprocess.CalledProcessError as e:
            print(f'⚠️ Git 命令执行失败，请检查是否在 Git 仓库中: {e}', file=sys.stderr)
        except Exception as e:
            print(f'⚠️ 生成 patch 时发生未知错误: {e}', file=sys.stderr)

    except Exception as error:
        print(f'❌ 处理过程中发生严重错误: {error}', file=sys.stderr)

if __name__ == "__main__":
    main()