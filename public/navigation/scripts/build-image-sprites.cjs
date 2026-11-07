/**
 * 将导航数据引用的图标合并为 CSS Sprite，并回写图标坐标。
 * 用法：node scripts/build-image-sprites.cjs [--keep-originals]
 */

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const dataFiles = ['01资源.json', '02服务.json'].map((name) => path.join(root, 'data', name));
const imageDir = path.join(root, 'img');
const spriteDir = imageDir;
const groupSize = 100;
const columns = 10;
const cellSize = 42;
const keepOriginals = process.argv.includes('--keep-originals');

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function collectSites(data) {
  return (data.categories || []).flatMap((category) => category.sites || []);
}

async function main() {
  const data = await Promise.all(dataFiles.map(readJson));
  const imagePaths = new Map();
  for (const site of data.flatMap(collectSites)) {
    if (typeof site.icon === 'string' && site.icon.startsWith('img/')) {
      imagePaths.set(site.icon, path.join(root, site.icon));
    }
  }

  const entries = [];
  for (const [relativePath, filePath] of imagePaths) {
    try {
      const metadata = await sharp(filePath).metadata();
      entries.push({ relativePath, filePath, width: metadata.width, height: metadata.height });
    } catch (error) {
      throw new Error(`无法读取图片 ${relativePath}: ${error.message}`);
    }
  }

  const sprites = [];
  for (let groupStart = 0; groupStart < entries.length; groupStart += groupSize) {
    const group = entries.slice(groupStart, groupStart + groupSize);
    const rows = Math.ceil(group.length / columns);
    const spriteWidth = columns * cellSize;
    const spriteHeight = rows * cellSize;
    const composites = group.map((entry, index) => ({
      input: entry.filePath,
      left: (index % columns) * cellSize,
      top: Math.floor(index / columns) * cellSize,
    }));
    const spriteName = `sprite-${String(sprites.length + 1).padStart(2, '0')}.webp`;
    const spritePath = path.join(spriteDir, spriteName);
    await sharp({ create: { width: spriteWidth, height: spriteHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(composites)
      .webp({ lossless: true })
      .toFile(spritePath);
    const sprite = { file: `img/${spriteName}`, width: spriteWidth, height: spriteHeight };
    sprites.push(sprite);
    group.forEach((entry, index) => {
      entry.sprite = sprite;
      entry.x = (index % columns) * cellSize;
      entry.y = Math.floor(index / columns) * cellSize;
    });
  }

  const lookup = new Map(entries.map((entry) => [entry.relativePath, entry]));
  for (const site of data.flatMap(collectSites)) {
    const entry = typeof site.icon === 'string' ? lookup.get(site.icon) : null;
    if (entry) {
      site.icon = {
        sprite: entry.sprite.file,
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height,
        spriteWidth: entry.sprite.width,
        spriteHeight: entry.sprite.height,
      };
    }
  }

  for (let i = 0; i < dataFiles.length; i += 1) {
    await fs.writeFile(dataFiles[i], `${JSON.stringify(data[i], null, 2)}\n`, 'utf8');
  }
  if (!keepOriginals) {
    const files = await fs.readdir(imageDir);
    await Promise.all(files
      .filter((file) => !file.startsWith('sprite-'))
      .map((file) => fs.unlink(path.join(imageDir, file))));
  }
  console.log(`已生成 ${sprites.length} 个 Sprite，处理 ${entries.length} 个唯一图标。`);
  if (keepOriginals) console.log('已保留原始图片（--keep-originals）。');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
