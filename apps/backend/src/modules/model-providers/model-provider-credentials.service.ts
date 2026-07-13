import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

@Injectable()
export class ModelProviderCredentialsService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = Buffer.from(config.getOrThrow<string>("MODEL_PROVIDER_ENCRYPTION_KEY"), "base64");
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [VERSION, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
  }

  decrypt(value: string): string {
    const [version, iv, authTag, ciphertext] = value.split(":");
    if (version !== VERSION || !iv || !authTag || !ciphertext) {
      throw new Error("invalid provider credential payload");
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
}
