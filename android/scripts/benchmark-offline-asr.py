#!/usr/bin/env python3
"""CPU-only reproducible smoke/segmentation benchmark; no private recordings or cloud API."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import socket
import tarfile
import time
import wave
import numpy as np
import sherpa_onnx

parser = argparse.ArgumentParser()
parser.add_argument('--cache', type=Path, required=True)
parser.add_argument('--assets', type=Path, required=True)
args = parser.parse_args()
# Fail any accidental Python networking. Models and fixtures must already be present.
socket.create_connection = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('network disabled during benchmark'))
manifest = json.loads((args.assets / 'manifest.json').read_text())
for name, info in manifest['files'].items():
    assert hashlib.file_digest((args.assets / name).open('rb'), 'sha256').hexdigest() == info['sha256'], name
fixtures = args.cache / 'benchmark-fixtures'
fixtures.mkdir(exist_ok=True)
with tarfile.open(args.cache / 'sense-voice-2024-int8.tar.bz2') as archive:
    for language in ['zh', 'en', 'yue']:
        name = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/' + language + '.wav'
        (fixtures / (language + '.wav')).write_bytes(archive.extractfile(name).read())
def read(language):
    with wave.open(str(fixtures / (language + '.wav'))) as w:
        assert w.getnchannels() == 1 and w.getframerate() == 16000 and w.getsampwidth() == 2
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
began = time.perf_counter()
recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=str(args.assets / 'model.int8.onnx'), tokens=str(args.assets / 'tokens.txt'),
    num_threads=2, use_itn=True, language='auto', provider='cpu', debug=False)
results = {'platform': platform.platform(), 'runtime': sherpa_onnx.__version__,
           'model': manifest['id'], 'threads': 2, 'initialization_seconds': time.perf_counter() - began, 'samples': []}
for language in ['zh', 'en', 'yue']:
    samples = read(language)
    start = time.perf_counter()
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    elapsed = time.perf_counter() - start
    assert stream.result.text.strip(), language
    results['samples'].append({'language': language, 'audio_seconds': len(samples) / 16000,
                               'seconds': elapsed, 'rtf': elapsed / (len(samples) / 16000), 'text': stream.result.text})
config = sherpa_onnx.VadModelConfig()
config.silero_vad.model = str(args.assets / 'silero_vad.onnx')
config.silero_vad.min_silence_duration = 0.6
config.silero_vad.min_speech_duration = 0.25
config.silero_vad.max_speech_duration = 20
config.sample_rate = 16000
config.num_threads = 1
vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=30)
for _ in range(313):
    vad.accept_waveform(np.zeros(512, np.float32))
vad.flush()
assert vad.empty(), 'Silence must not create a recognizer request'
results['silence_seconds'] = 313 * 512 / 16000
results['silence_segments'] = 0
vad.reset()
long_audio = np.concatenate([np.concatenate([read('zh'), np.zeros(16000, np.float32)]) for _ in range(5)])
segments = []
start = time.perf_counter()
for position in range(0, len(long_audio), 512):
    window = long_audio[position:position + 512]
    if len(window) < 512: window = np.pad(window, (0, 512 - len(window)))
    vad.accept_waveform(window)
    while not vad.empty():
        segment = vad.front
        segments.append((int(segment.start), len(segment.samples)))
        stream = recognizer.create_stream(); stream.accept_waveform(16000, segment.samples)
        recognizer.decode_stream(stream)
        assert stream.result.text.strip()
        vad.pop()
vad.flush()
while not vad.empty():
    segment = vad.front; segments.append((int(segment.start), len(segment.samples))); vad.pop()
assert len(segments) == 5, segments
assert all(length <= 22 * 16000 for _, length in segments), segments
results['continuous'] = {'audio_seconds': len(long_audio) / 16000, 'segments': len(segments),
                         'boundaries_samples': segments, 'seconds': time.perf_counter() - start}

# These are alternating complete official utterances, not an accuracy corpus of intra-sentence code-switching.
mixed_inputs = []
mixed_parts = []
mixed_offset = 0
for index, language in enumerate(['zh', 'en', 'zh', 'en']):
    samples = read(language)
    mixed_inputs.append({
        'index': index,
        'fixture_language': language,
        'start_sample': mixed_offset,
        'end_sample': mixed_offset + len(samples),
    })
    mixed_parts.append(samples)
    mixed_offset += len(samples)
    if index < 3:
        gap = np.zeros(round(0.7 * 16000), np.float32)
        mixed_parts.append(gap)
        mixed_offset += len(gap)
mixed_audio = np.concatenate(mixed_parts)
mixed_segments = []


def drain_mixed():
    while not vad.empty():
        segment = vad.front
        start_sample = int(segment.start)
        end_sample = start_sample + len(segment.samples)
        overlaps = [max(0, min(end_sample, item['end_sample']) - max(start_sample, item['start_sample']))
                    for item in mixed_inputs]
        assert max(overlaps) > 0, 'A language-switch segment must overlap a real fixture utterance'
        fixture_index = overlaps.index(max(overlaps))
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, segment.samples)
        recognizer.decode_stream(stream)
        text = stream.result.text.strip()
        assert text, 'Each detected language-switch segment must contain recognized text'
        mixed_segments.append({
            'fixture_index': fixture_index,
            'fixture_language': mixed_inputs[fixture_index]['fixture_language'],
            'start_sample': start_sample,
            'end_sample': end_sample,
            'start_ms': start_sample * 1000 / 16000,
            'end_ms': end_sample * 1000 / 16000,
            'text': text,
        })
        vad.pop()


vad.reset()
start = time.perf_counter()
for position in range(0, len(mixed_audio), 512):
    window = mixed_audio[position:position + 512]
    if len(window) < 512:
        window = np.pad(window, (0, 512 - len(window)))
    vad.accept_waveform(window)
    drain_mixed()
vad.flush()
drain_mixed()
mixed_seconds = time.perf_counter() - start
assert all(0 <= item['start_sample'] < item['end_sample'] for item in mixed_segments), mixed_segments
assert all(previous['end_sample'] <= following['start_sample']
           for previous, following in zip(mixed_segments, mixed_segments[1:])), mixed_segments
assert [item['fixture_index'] for item in mixed_segments] == sorted(item['fixture_index'] for item in mixed_segments)
assert all(any(segment['fixture_index'] == index for segment in mixed_segments) for index in range(4)), mixed_segments
results['language_switch'] = {
    'language_mode': 'auto',
    'gap_seconds': 0.7,
    'audio_seconds': len(mixed_audio) / 16000,
    'seconds': mixed_seconds,
    'rtf': mixed_seconds / (len(mixed_audio) / 16000),
    'inputs': mixed_inputs,
    'segments': mixed_segments,
    'all_four_utterances_have_text': True,
    'timestamps_ordered_and_non_overlapping': True,
    'scope': 'Alternating complete official Mandarin/English utterances; not a code-switch accuracy benchmark.',
}
print(json.dumps(results, ensure_ascii=False, indent=2))
