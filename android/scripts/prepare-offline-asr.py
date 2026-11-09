#!/usr/bin/env python3
"""Fetch immutable, SHA-256 verified upstream artifacts. Model weights never enter Git."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get('ASTERING_ASR_CACHE', str(Path.home() / '.cache/astering-offline-asr')))
OUTPUT = ROOT / '.offline'
ARTIFACTS = [
    ('sherpa-onnx-2.0.1.aar', 678842484, '07e042d97f3a6bd5b7fe74d4eef0513dc01a714b16c15a903250095aba43a575'),
    ('silero_vad.onnx', 271935959, '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'),
    ('sense-voice-2024-int8.tar.bz2', 288366523, '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e'),
]

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, asset, expected in ARTIFACTS:
        target = CACHE / name
        if not target.exists() or digest(target) != expected:
            request = urllib.request.Request(
                f'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/assets/{asset}?download={int(time.time())}',
                headers={'Accept': 'application/octet-stream', 'User-Agent': 'Astering-offline-model-build'})
            temporary = target.with_suffix(target.suffix + '.part')
            try:
                with urllib.request.urlopen(request, timeout=90) as response, temporary.open('wb') as out:
                    shutil.copyfileobj(response, out, 1024 * 1024)
                if digest(temporary) != expected:
                    raise RuntimeError(f'SHA-256 mismatch: {name}')
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        print(f'Verified {name}', flush=True)
    shutil.copyfile(CACHE / ARTIFACTS[0][0], OUTPUT / 'sherpa-onnx.aar')
    models = OUTPUT / 'assets/offline-asr'
    models.mkdir(parents=True, exist_ok=True)
    archive_root = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/'
    with tarfile.open(CACHE / ARTIFACTS[2][0]) as archive:
        for name in ['model.int8.onnx', 'tokens.txt']:
            with archive.extractfile(archive_root + name) as src, (models / name).open('wb') as out:
                shutil.copyfileobj(src, out, 1024 * 1024)
    shutil.copyfile(CACHE / 'silero_vad.onnx', models / 'silero_vad.onnx')
    manifest = {'id': 'sensevoice-small-int8-2024-07-17', 'runtime': 'sherpa-onnx 2.0.1',
                'source': 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
                'revision': '2365baeacb507f821a0c8120fcee3d484dba7a07',
                'files': {f.name: {'bytes': f.stat().st_size, 'sha256': digest(f)} for f in models.iterdir() if f.suffix in ['.onnx', '.txt']}}
    (models / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    shutil.copytree(ROOT / 'licenses', models / 'licenses', dirs_exist_ok=True)
    shutil.copyfile(ROOT.parent / 'LICENSE', models / 'licenses/Astering-LICENSE')
    print(json.dumps(manifest, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    main()
