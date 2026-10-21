import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.util.Properties;

class SignRelease {
    public static void main(String[] args) throws Exception {
        if (args.length < 1 || args.length > 2) throw new IllegalArgumentException("Explicit Android stage and optional channel required");
        var channel = args.length == 2 ? args[1] : "beta";
        if (!channel.equals("beta") && !channel.equals("production")) throw new IllegalArgumentException("Unknown release channel");
        var properties = new Properties();
        if (channel.equals("production")) {
            properties.setProperty("storeFile", "/home/kenan/.android/debug.keystore");
            properties.setProperty("storePassword", "android");
            properties.setProperty("keyPassword", "android");
            properties.setProperty("keyAlias", "androiddebugkey");
        } else try (var input = Files.newInputStream(Path.of("/etc/kenan/android-signing.properties"))) { properties.load(input); }
        if (channel.equals("beta") && (!"/etc/kenan/android-signing.jks".equals(properties.getProperty("storeFile")) || !"kenan-beta".equals(properties.getProperty("keyAlias"))))
            throw new IllegalArgumentException("Independent Beta signer required");
        var store = KeyStore.getInstance("JKS");
        try (var input = Files.newInputStream(Path.of(properties.getProperty("storeFile")))) { store.load(input, properties.getProperty("storePassword").toCharArray()); }
        var alias = properties.getProperty("keyAlias");
        var key = (PrivateKey) store.getKey(alias, properties.getProperty("keyPassword").toCharArray());
        var signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(key);
        signer.update(Files.readAllBytes(Path.of(args[0], "manifest.json")));
        Files.write(Path.of(args[0], "manifest.sig"), signer.sign());
        Files.write(Path.of(args[0], "signer.der"), store.getCertificate(alias).getEncoded());
    }
}
