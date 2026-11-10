package space.tcymc.astering;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Immutable upstream revisions and hashes, independent of the configured Astering server. */
final class OfflineModelCatalog {
    static final String SENSEVOICE = "sensevoice-small-int8-2024-07-17";
    static final String X_ASR = "x-asr-zh-en-punct-int8-2026-06-03";
    static final String QWEN = "qwen3-asr-06b-int8-2026-03-25";

    static final class Model {
        final String id;
        final String name;
        final String descriptionZh;
        final String descriptionEn;
        final String source;
        final String license;
        final String engine;
        final List<OfflineModelDownload.Asset> assets;

        private Model(String id, String name, String descriptionZh, String descriptionEn,
                String repository, String revision, String license, String engine,
                OfflineModelDownload.Asset... assets) {
            this.id = id;
            this.name = name;
            this.descriptionZh = descriptionZh;
            this.descriptionEn = descriptionEn;
            this.source = "https://huggingface.co/" + repository + "/tree/" + revision;
            this.license = license;
            this.engine = engine;
            this.assets = Collections.unmodifiableList(Arrays.asList(assets));
        }

        long bytes() {
            long total = 0;
            for (OfflineModelDownload.Asset asset : assets) total += asset.bytes;
            return total;
        }
    }

    private static OfflineModelDownload.Asset asset(String repository, String revision,
            String name, long bytes, String sha256) {
        return new OfflineModelDownload.Asset(name,
            "https://huggingface.co/" + repository + "/resolve/" + revision + "/" + name,
            bytes, sha256);
    }

    private static final String SENSE_REPOSITORY =
        "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
    private static final String SENSE_REVISION = "2365baeacb507f821a0c8120fcee3d484dba7a07";
    private static final String X_ASR_REPOSITORY =
        "csukuangfj2/sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03";
    private static final String X_ASR_REVISION = "ce812cc05d858539a68dd42e86f4fd7a9ce1acf0";
    private static final String QWEN_REPOSITORY =
        "csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25";
    private static final String QWEN_REVISION = "68818b2313fe77bd06f6a7c5068ff3ef59d02b8a";

    private static final List<Model> MODELS = Collections.unmodifiableList(Arrays.asList(
        new Model(SENSEVOICE, "SenseVoiceSmall int8",
            "中英日韩粤语，自动判断语言；按停顿分句后显示文字。可作为现有离线方案继续使用。",
            "Chinese, English, Japanese, Korean and Cantonese with automatic language detection. "
                + "Text appears after each speech segment; keeps the existing offline option.",
            SENSE_REPOSITORY, SENSE_REVISION, "FunASR Model License 1.1", "sense_voice",
            asset(SENSE_REPOSITORY, SENSE_REVISION, "model.int8.onnx", 239233841L,
                "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"),
            asset(SENSE_REPOSITORY, SENSE_REVISION, "tokens.txt", 315894L,
                "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc")),
        new Model(X_ASR, "X-ASR zh-en int8",
            "中英混合识别，带标点与英文大小写。此处使用离线分句版，按停顿出字，并非逐字流式。",
            "Chinese-English recognition with punctuation and capitalization. This is the offline "
                + "segment-based export, not word-by-word streaming.",
            X_ASR_REPOSITORY, X_ASR_REVISION, "Apache-2.0", "zipformer",
            asset(X_ASR_REPOSITORY, X_ASR_REVISION, "encoder-epoch-99-avg-1.int8.onnx", 161744450L,
                "fe0198b52626f2a1012ebb6d6a7259c5137c4c964f3a524135e353f4687b5d14"),
            asset(X_ASR_REPOSITORY, X_ASR_REVISION, "decoder-epoch-99-avg-1.onnx", 11309084L,
                "a9fe7c320337e6f510809c028a8accf074d45f42aab852e2d29830babc41a3f9"),
            asset(X_ASR_REPOSITORY, X_ASR_REVISION, "joiner-epoch-99-avg-1.int8.onnx", 2581422L,
                "aedb7fa697b2ab43f20499826fff7c997eea7d67db77be97769aeeeb726e63b3"),
            asset(X_ASR_REPOSITORY, X_ASR_REVISION, "tokens.txt", 58806L,
                "b818a60878b9aae978cbb8ad594acbd403d76d1af2e31ef4197c84e2dbdba27c")),
        new Model(QWEN, "Qwen3-ASR 0.6B int8",
            "多语言及中文方言，按停顿分句识别。此兼容版本实际接近 1 GB，本机 CPU 测试进程内存峰值约 2 GiB；"
                + "手机内存与耗电仍需实测，建议先试用，尚无长时真机性能结论。",
            "Multilingual and Chinese dialect recognition after each speech segment. This compatible "
                + "export is nearly 1 GB; CPU tests peaked at about 2 GiB of process memory. Try it on your device first; "
                + "sustained phone performance has not been measured in this app.",
            QWEN_REPOSITORY, QWEN_REVISION, "Apache-2.0", "qwen3_asr",
            asset(QWEN_REPOSITORY, QWEN_REVISION, "conv_frontend.onnx", 44148281L,
                "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e"),
            asset(QWEN_REPOSITORY, QWEN_REVISION, "encoder.int8.onnx", 182491662L,
                "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9"),
            asset(QWEN_REPOSITORY, QWEN_REVISION, "decoder.int8.onnx", 755914231L,
                "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771"),
            asset(QWEN_REPOSITORY, QWEN_REVISION, "tokenizer/merges.txt", 1671853L,
                "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5"),
            asset(QWEN_REPOSITORY, QWEN_REVISION, "tokenizer/tokenizer_config.json", 12487L,
                "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c"),
            asset(QWEN_REPOSITORY, QWEN_REVISION, "tokenizer/vocab.json", 2776833L,
                "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910"))
    ));

    static List<Model> all() { return MODELS; }

    static Model get(String id) {
        for (Model model : MODELS) if (model.id.equals(id)) return model;
        return null;
    }

    private OfflineModelCatalog() { }
}
