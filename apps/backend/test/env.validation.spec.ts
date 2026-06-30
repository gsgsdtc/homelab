import { validateEnvironment } from "../src/config/env.validation";

describe("validateEnvironment", () => {
  it("rejects startup configuration when JWT_SECRET is missing", () => {
    expect(() => validateEnvironment({})).toThrow("JWT_SECRET is required");
  });

  it("accepts a configured JWT_SECRET and applies defaults", () => {
    expect(validateEnvironment({ JWT_SECRET: "local-secret" })).toMatchObject({
      PORT: 3000,
      JWT_SECRET: "local-secret",
      JWT_EXPIRES_IN: "1h"
    });
  });
});
