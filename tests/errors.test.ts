import { describe, expect, it } from "vitest";

import { AppError, ERROR_MESSAGES } from "../src/errors";

describe("AppError", () => {
  it("uses the standard code, message, and response shape", () => {
    const error = new AppError("RESOURCE_NOT_FOUND");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(ERROR_MESSAGES.RESOURCE_NOT_FOUND);
    expect(error.toJSON()).toEqual({
      error: "RESOURCE_NOT_FOUND",
      message: "The requested resource could not be found.",
    });
  });

  it("allows a more specific message while preserving the code", () => {
    const error = new AppError("INVALID_REQUEST", "limit must be positive");

    expect(error.toJSON()).toEqual({
      error: "INVALID_REQUEST",
      message: "limit must be positive",
    });
  });

  it("adds safe retry timing to rate-limit responses", () => {
    const error = new AppError("RATE_LIMITED");

    expect(error.toJSON()).toEqual({
      error: "RATE_LIMITED",
      message: "The upstream provider rate limit was exceeded.",
      retry_after_seconds: 60,
    });
  });
});
