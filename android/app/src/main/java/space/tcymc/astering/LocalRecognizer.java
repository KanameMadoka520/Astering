package space.tcymc.astering;

import android.content.res.AssetManager;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineQwen3AsrModelConfig;
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig;
import com.k2fsa.sherpa.onnx.OfflineStream;
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig;
import com.k2fsa.sherpa.onnx.SileroVadModelConfig;
import com.k2fsa.sherpa.onnx.SpeechSegment;
import com.k2fsa.sherpa.onnx.Vad;
import com.k2fsa.sherpa.onnx.VadModelConfig;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** CPU-only installed model + bundled Silero. Raw sound stays in finite RAM, never in files. */
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
    private final OfflineModels.Lease lease;
    private final ThreadPoolExecutor inference = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(3), runnable -> new Thread(runnable, "Astering-ASR"));
    private final AtomicInteger pending = new AtomicInteger();
    private final float[] vadWindow = new float[512];
    private int windowSamples;
    private OfflineRecognizer recognizer;
    private Vad vad;
    private volatile boolean cancelled;
    private boolean finishing;

    LocalRecognizer(AssetManager assets, OfflineModels.Lease lease, String language, Listener listener) {
        this.listener = listener;
        this.lease = lease;
        inference.execute(() -> {
            try {
                if (cancelled) { releaseRecognizer(); return; }
                recognizer = new OfflineRecognizer(null, configuration(lease));
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
            } catch (RuntimeException | LinkageError | OutOfMemoryError error) {
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
                } catch (RuntimeException | LinkageError | OutOfMemoryError error) {
                    releaseRecognizer();
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
        if (!inference.isShutdown()) {
            inference.getQueue().clear();
            inference.execute(this::releaseRecognizer);
            inference.shutdown();
        }
        // finish() already queued teardown before shutdown; abort must not discard that finalizer.
    }

    private void releaseRecognizer() {
        try {
            if (recognizer != null) {
                OfflineRecognizer previous = recognizer;
                recognizer = null;
                previous.release();
            }
        } catch (RuntimeException | LinkageError | OutOfMemoryError ignored) {
            // An exceptional JNI teardown must not leave an installed model permanently locked.
        } finally {
            lease.close();
        }
    }

    static OfflineRecognizerConfig configuration(OfflineModels.Lease lease) {
        OfflineRecognizerConfig config = new OfflineRecognizerConfig();
        config.setModelConfig(modelConfig(lease));
        config.getFeatConfig().setSampleRate(16000);
        config.getFeatConfig().setFeatureDim("qwen3_asr".equals(lease.model.engine) ? 128 : 80);
        return config;
    }

    private static OfflineModelConfig modelConfig(OfflineModels.Lease lease) {
        OfflineModelConfig model = new OfflineModelConfig();
        model.setNumThreads(2);
        model.setProvider("cpu");
        switch (lease.model.engine) {
            case "sense_voice":
                OfflineSenseVoiceModelConfig sense = new OfflineSenseVoiceModelConfig();
                sense.setModel(lease.path("model.int8.onnx"));
                // UI language must not force monolingual decoding of mixed Chinese-English notes.
                sense.setLanguage("auto");
                sense.setUseInverseTextNormalization(true);
                model.setSenseVoice(sense);
                model.setTokens(lease.path("tokens.txt"));
                model.setModelType("sense_voice");
                break;
            case "zipformer":
                OfflineTransducerModelConfig transducer = new OfflineTransducerModelConfig();
                transducer.setEncoder(lease.path("encoder-epoch-99-avg-1.int8.onnx"));
                transducer.setDecoder(lease.path("decoder-epoch-99-avg-1.onnx"));
                transducer.setJoiner(lease.path("joiner-epoch-99-avg-1.int8.onnx"));
                model.setTransducer(transducer);
                model.setTokens(lease.path("tokens.txt"));
                model.setModelType("transducer");
                break;
            case "qwen3_asr":
                OfflineQwen3AsrModelConfig qwen = new OfflineQwen3AsrModelConfig();
                qwen.setConvFrontend(lease.path("conv_frontend.onnx"));
                qwen.setEncoder(lease.path("encoder.int8.onnx"));
                qwen.setDecoder(lease.path("decoder.int8.onnx"));
                qwen.setTokenizer(lease.path("tokenizer"));
                // The native default of 128 output tokens can truncate a fast 20-second Chinese segment.
                qwen.setMaxNewTokens(512);
                qwen.setMaxTotalLen(2048);
                model.setQwen3Asr(qwen);
                model.setTokens("");
                break;
            default:
                throw new IllegalArgumentException("Unsupported installed ASR engine");
        }
        return model;
    }
}
