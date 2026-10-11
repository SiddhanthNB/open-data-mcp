import { parse } from "yaml";
import { z } from "zod";

const authPathSchema = z
  .string()
  .startsWith("/")
  .refine((value) => !value.includes("?") && !value.includes("#"), {
    message: "auth paths must not contain a query or fragment",
  });

const publicBaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";

    return url.protocol === "https:" || (url.protocol === "http:" && loopback);
  }, "public_base_url must use HTTPS, except on a loopback host")
  .refine((value) => new URL(value).origin === value, {
    message: "public_base_url must be an origin without a path",
  });

const envNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const scopeSchema = z.array(z.string().min(1)).min(1).refine(
  (scopes) => new Set(scopes).size === scopes.length,
  "scopes must not contain duplicates",
);

const rateLimitPairSchema = z
  .object({
    requests_per_minute: z.number().int().positive(),
    requests_per_24_hours: z.number().int().positive(),
  })
  .strict();

const providerRateLimitSchema = rateLimitPairSchema.extend({
  requests_per_hour: z.number().int().positive(),
});

const serverConfigSchema = z
  .object({
    auth: z
      .object({
        mode: z.enum(["none", "oauth", "bearer"]),
        bearer: z
          .object({
            token_env: envNameSchema,
          })
          .strict(),
        oauth: z
          .object({
            public_base_url: publicBaseUrlSchema,
            authorize_path: authPathSchema,
            callback_path: authPathSchema,
            token_path: authPathSchema,
            registration_path: authPathSchema,
            scopes_supported: scopeSchema,
            required_scopes: scopeSchema,
            github: z
              .object({
                client_id_env: envNameSchema,
                client_secret_env: envNameSchema,
                authorize_url: z.string().url().startsWith("https://"),
                token_url: z.string().url().startsWith("https://"),
                user_url: z.string().url().startsWith("https://"),
                timeout_ms: z.number().int().positive(),
              })
              .strict(),
          })
          .strict()
          .superRefine((oauth, context) => {
            const paths = [
              oauth.authorize_path,
              oauth.callback_path,
              oauth.token_path,
              oauth.registration_path,
            ];
            if (new Set(paths).size !== paths.length) {
              context.addIssue({
                code: "custom",
                message: "OAuth endpoint paths must be unique",
              });
            }

            for (const requiredScope of oauth.required_scopes) {
              if (!oauth.scopes_supported.includes(requiredScope)) {
                context.addIssue({
                  code: "custom",
                  message: `required scope is not supported: ${requiredScope}`,
                  path: ["required_scopes"],
                });
              }
            }
          }),
      })
      .strict(),
    resources: z
      .object({
        max_input_bytes: z.number().int().positive(),
        max_output_bytes: z.number().int().positive(),
      })
      .strict(),
    rate_limits: z
      .object({
        redis: z
          .object({
            url_env: envNameSchema,
            token_env: envNameSchema,
            timeout_ms: z.number().int().positive(),
            key_prefix: z.string().regex(/^[a-z0-9][a-z0-9:-]*$/),
          })
          .strict(),
        user: rateLimitPairSchema,
        global: rateLimitPairSchema,
        oauth: z
          .object({
            requests_per_minute_per_ip: z.number().int().positive(),
          })
          .strict(),
        providers: z
          .object({
            open_meteo_ie: providerRateLimitSchema,
          })
          .strict(),
      })
      .strict()
      .superRefine((limits, context) => {
        if (
          limits.global.requests_per_minute <
          limits.user.requests_per_minute
        ) {
          context.addIssue({
            code: "custom",
            message: "global minute limit must not be lower than user limit",
            path: ["global", "requests_per_minute"],
          });
        }
        if (
          limits.global.requests_per_24_hours <
          limits.user.requests_per_24_hours
        ) {
          context.addIssue({
            code: "custom",
            message: "global 24-hour limit must not be lower than user limit",
            path: ["global", "requests_per_24_hours"],
          });
        }
      }),
  })
  .strict();

export type ServerConfig = Readonly<z.infer<typeof serverConfigSchema>>;
export type AuthConfig = ServerConfig["auth"];
export type OAuthConfig = AuthConfig["oauth"];

export class ServerConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServerConfigError";
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }

  return value;
}

export function parseServerConfig(contents: string): ServerConfig {
  let document: unknown;

  try {
    document = parse(contents);
  } catch (cause) {
    throw new ServerConfigError("Invalid server configuration YAML", { cause });
  }

  const result = serverConfigSchema.safeParse(document);
  if (!result.success) {
    throw new ServerConfigError(
      `Invalid server configuration: ${z.prettifyError(result.error)}`,
      { cause: result.error },
    );
  }

  return deepFreeze(result.data);
}
