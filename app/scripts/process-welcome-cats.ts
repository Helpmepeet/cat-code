import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Pillow handles alpha-aware cropping/resampling; cwebp preserves the resized alpha
// losslessly. The source PNGs remain editable and are never renderer imports.
const result = spawnSync('uv', [
  'run', '--offline', '--with', 'pillow', 'python', '-c', String.raw`
import pathlib, re, subprocess, sys, tempfile
from PIL import Image

root = pathlib.Path(sys.argv[1])
check = '--check' in sys.argv[2:]
module = root / 'app/renderer/src/generatedWelcomeCats.ts'
names = re.findall(r"generated-welcome-cats/([\w-]+)\.webp'", module.read_text())
assert len(names) == len(set(names)) == 28, 'Expected 28 explicit display imports'
folder = module.parent / 'assets/generated-welcome-cats'
source_bytes = display_bytes = 0
with tempfile.TemporaryDirectory() as temporary:
    for name in names:
        source = folder / (name + '.png')
        target = folder / (name + '.webp')
        with Image.open(source) as image:
            image = image.convert('RGBA')
            bounds = image.getchannel('A').getbbox()
            assert bounds is not None, name
            image = image.crop(bounds)
            # Two device pixels per CSS pixel in the 248 x 211 hero slot.
            image.thumbnail((496, 422), Image.Resampling.LANCZOS)
            # Resampling can erase isolated subpixel alpha at the source edges.
            image = image.crop(image.getchannel('A').getbbox())
            if not check:
                resized = pathlib.Path(temporary) / (name + '.png')
                image.save(resized)
                subprocess.run(['cwebp', '-quiet', '-q', '85', '-m', '6',
                                '-alpha_q', '100', '-exact', str(resized),
                                '-o', str(target)], check=True)
            with Image.open(target) as display:
                assert display.format == 'WEBP', name
                assert display.size == image.size, (name, display.size, image.size)
                alpha = display.convert('RGBA').getchannel('A')
                assert alpha.tobytes() == image.getchannel('A').tobytes(), name
                box = alpha.getbbox()
                assert box is not None, name
                margins = (box[0], box[1], display.width-box[2], display.height-box[3])
                assert max(margins) <= 2, (name, margins)
                assert alpha.getextrema()[0] == 0, (name, 'missing transparency')
                print(f'{name}: {display.width}x{display.height}, alpha margins {margins}, {target.stat().st_size} bytes')
        source_bytes += source.stat().st_size
        display_bytes += target.stat().st_size
assert display_bytes < source_bytes / 10, (source_bytes, display_bytes)
print(f'Source: {source_bytes} bytes; display: {display_bytes} bytes; reduction: {100*(1-display_bytes/source_bytes):.2f}%')
`, fileURLToPath(new URL('../../', import.meta.url)), ...process.argv.slice(2),
], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
