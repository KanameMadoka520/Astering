package space.tcymc.astering;

import android.content.res.AssetManager;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig;
import com.k2fsa.sherpa.onnx.OfflineStream;
import com.k2fsa.sherpa.onnx.SileroVadModelConfig;
import com.k2fsa.sherpa.onnx.SpeechSegment;
import com.k2fsa.sherpa.onnx.Vad;
import com.k2fsa.sherpa.onnx.VadModelConfig;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** CPU-only SenseVoice + Silero. Raw sound exists only in finite RAM, never in files. */
final class LocalRecognizer {
    static final String MODEL = "SenseVoiceSmall int8 · 2024-07-17";
    static final String MODEL_ID = "sensevoice-small-int8-2024-07-17";
    interface Listener {
        void ready();
        void result(String text, long startMs, long endMs, long inferenceMs);
        void failed(String code);
        void finished();
    }
    private final Listener listener;
    private final ThreadPoolExecutor inference = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(3), runnable -> new Thread(runnable, "Astering-ASR"));
    private final AtomicInteger pending = new AtomicInteger();
    private final float[] vadWindow = new float[512];
    private int windowSamples;
    private OfflineRecognizer recognizer;
    private Vad vad;
    private volatile boolean cancelled;
    private boolean finishing;

    LocalRecognizer(AssetManager assets, String language, Listener listener) {
        this.listener = listener;
        inference.execute(() -> {
            try {
                OfflineSenseVoiceModelConfig sense = new OfflineSenseVoiceModelConfig();
                sense.setModel("offline-asr/model.int8.onnx");
                // Interface language must not force monolingual recognition of mixed Chinese/English notes.
                sense.setLanguage("auto");
                sense.setUseInverseTextNormalization(true);
                OfflineModelConfig model = new OfflineModelConfig();
                model.setSenseVoice(sense);
                model.setTokens("offline-asr/tokens.txt");
                model.setModelType("sense_voice");
                // Two CPU threads leave headroom for capture/UI and limit sustained CPU use.
                model.setNumThreads(2);
                model.setProvider("cpu");
                OfflineRecognizerConfig config = new OfflineRecognizerConfig();
                config.setModelConfig(model);
                recognizer = new OfflineRecognizer(assets, config);
                SileroVadModelConfig silero = new SileroVadModelConfig();
                silero.setModel("offline-asr/silero_vad.onnx");
                silero.setMinSilenceDuration(0.6f);
                silero.setMinSpeechDuration(0.25f);
                silero.setMaxSpeechDuration(20f);
                VadModelConfig vadConfig = new VadModelConfig();
                vadConfig.setSileroVadModelConfig(silero);
                vadConfig.setSampleRate(16000);
                vadConfig.setNumThreads(1);
                synchronized (this) {
                    if (!cancelled) vad = new Vad(assets, vadConfig);
                }
                if (cancelled) releaseRecognizer();
                else listener.ready();
            } catch (RuntimeException | LinkageError error) {
                releaseRecognizer();
                if (!cancelled) listener.failed("local_model");
            }
        });
    }

    synchronized boolean accept(byte[] pcm) {
        if (cancelled || finishing || vad == null) return false;
        for (int i = 0; i + 1 < pcm.length; i += 2) {
            short sample = (short) ((pcm[i] & 255) | (pcm[i + 1] << 8));
            vadWindow[windowSamples++] = sample / 32768f;
            if (windowSamples == vadWindow.length) {
                vad.acceptWaveform(vadWindow);
                windowSamples = 0;
                if (!drain()) return false;
            }
        }
        return true;
    }

    private boolean drain() {
        while (!vad.empty()) {
            // At most two 20-second utterances wait/run in inference; backpressure pauses capture visibly.
            if (pending.get() >= 2) return false;
            SpeechSegment segment = vad.front();
            vad.pop();
            pending.incrementAndGet();
            inference.execute(() -> {
                try {
                    if (cancelled || recognizer == null) return;
                    OfflineStream stream = recognizer.createStream();
                    long began = android.os.SystemClock.elapsedRealtime();
                    try {
                        stream.acceptWaveform(segment.getSamples(), 16000);
                        recognizer.decode(stream);
                        String text = recognizer.getResult(stream).getText().trim();
                        if (!cancelled && !text.isEmpty()) listener.result(text, segment.getStart() * 1000 / 16000,
                            (segment.getStart() + segment.getSamples().length) * 1000 / 16000,
                            android.os.SystemClock.elapsedRealtime() - began);
                    } finally {
                        stream.release();
                    }
                } catch (RuntimeException | LinkageError error) {
                    if (!cancelled) listener.failed("local_inference");
                } finally {
                    pending.decrementAndGet();
                }
            });
        }
        return true;
    }

    synchronized boolean finish() {
        if (finishing || cancelled) return true;
        if (vad == null) { abort(); listener.finished(); return true; }
        if (windowSamples > 0) {
            Arrays.fill(vadWindow, windowSamples, vadWindow.length, 0);
            vad.acceptWaveform(vadWindow);
            windowSamples = 0;
        }
        vad.flush();
        // Keep final VAD content until running inference catches up; caller retries finish on its next tick.
        if (!drain()) return false;
        finishing = true;
        vad.release();
        vad = null;
        inference.execute(() -> { releaseRecognizer(); if (!cancelled) listener.finished(); });
        inference.shutdown();
        return true;
    }

    synchronized void abort() {
        if (cancelled) return;
        cancelled = true;
        if (vad != null) { vad.release(); vad = null; }
        inference.getQueue().clear();
        if (!inference.isShutdown()) {
            inference.execute(this::releaseRecognizer);
            inference.shutdown();
        }
    }

    private void releaseRecognizer() {
        if (recognizer != null) { recognizer.release(); recognizer = null; }
    }
}
