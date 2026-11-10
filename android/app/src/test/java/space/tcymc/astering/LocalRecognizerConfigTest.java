package space.tcymc.astering;

import static org.junit.Assert.*;

import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import java.io.File;
import org.junit.Test;

public class LocalRecognizerConfigTest {
    private static OfflineRecognizerConfig configuration(String id) {
        return LocalRecognizer.configuration(new OfflineModels.Lease(null,
            OfflineModelCatalog.get(id), new File("/installed-model")));
    }

    @Test public void senseVoiceKeepsAutomaticLanguageAndUsesInstalledFiles() {
        OfflineRecognizerConfig config = configuration(OfflineModelCatalog.SENSEVOICE);
        OfflineModelConfig model = config.getModelConfig();
        assertEquals(16000, config.getFeatConfig().getSampleRate());
        assertEquals(80, config.getFeatConfig().getFeatureDim());
        assertEquals("/installed-model/model.int8.onnx", model.getSenseVoice().getModel());
        assertEquals("/installed-model/tokens.txt", model.getTokens());
        assertEquals("auto", model.getSenseVoice().getLanguage());
        assertTrue(model.getSenseVoice().getUseInverseTextNormalization());
        assertEquals("cpu", model.getProvider());
        assertEquals(2, model.getNumThreads());
    }

    @Test public void xAsrUsesTheMatchingOfflineTransducerArtifacts() {
        OfflineRecognizerConfig config = configuration(OfflineModelCatalog.X_ASR);
        OfflineModelConfig model = config.getModelConfig();
        assertEquals(80, config.getFeatConfig().getFeatureDim());
        assertEquals("transducer", model.getModelType());
        assertEquals("/installed-model/encoder-epoch-99-avg-1.int8.onnx", model.getTransducer().getEncoder());
        assertEquals("/installed-model/decoder-epoch-99-avg-1.onnx", model.getTransducer().getDecoder());
        assertEquals("/installed-model/joiner-epoch-99-avg-1.int8.onnx", model.getTransducer().getJoiner());
        assertEquals("/installed-model/tokens.txt", model.getTokens());
    }

    @Test public void qwenUses128MelFeaturesAndBudgetForFullTwentySecondSegments() {
        OfflineRecognizerConfig config = configuration(OfflineModelCatalog.QWEN);
        OfflineModelConfig model = config.getModelConfig();
        assertEquals(128, config.getFeatConfig().getFeatureDim());
        assertEquals("/installed-model/conv_frontend.onnx", model.getQwen3Asr().getConvFrontend());
        assertEquals("/installed-model/encoder.int8.onnx", model.getQwen3Asr().getEncoder());
        assertEquals("/installed-model/decoder.int8.onnx", model.getQwen3Asr().getDecoder());
        assertEquals("/installed-model/tokenizer", model.getQwen3Asr().getTokenizer());
        assertEquals("", model.getTokens());
        assertTrue(model.getQwen3Asr().getMaxNewTokens() >= 512);
        assertTrue(model.getQwen3Asr().getMaxTotalLen() >= 2048);
    }
}
