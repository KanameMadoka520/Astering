# WebMessageListener is registered through AndroidX; no reflection-based JavaScript interface is used.
-keepattributes Signature,InnerClasses,EnclosingMethod

# sherpa JNI reads config/result fields by their upstream names.
-keep class com.k2fsa.sherpa.onnx.** { *; }
