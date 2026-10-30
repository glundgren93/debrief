import { execFileSync } from "node:child_process";
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { CloudWatchSourceConfig } from "../config.ts";

export class SourceError extends Error {}

interface ProcessCredentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken?: string;
  Expiration?: string;
}

function credentialsFromProcess(command: string | string[]) {
  const env = { ...process.env };
  for (const key of ["AWS_VAULT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN"]) delete env[key];
  const args = Array.isArray(command) ? [...command] : ["-c", command];
  const executable = Array.isArray(command) ? args.shift() : "/bin/sh";
  if (!executable) throw new SourceError("Credential command must not be empty");
  const displayCommand = Array.isArray(command) ? command.join(" ") : command;
  let output: string;
  try {
    output = execFileSync(executable, args, { env, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"], timeout: 120_000 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new SourceError(`Credential command failed: ${displayCommand}${stderr ? `\n${stderr}` : ""}`);
  }
  const parsed = JSON.parse(output) as ProcessCredentials;
  return {
    accessKeyId: parsed.AccessKeyId,
    secretAccessKey: parsed.SecretAccessKey,
    sessionToken: parsed.SessionToken,
    expiration: parsed.Expiration ? new Date(parsed.Expiration) : undefined,
  };
}

function client(source: CloudWatchSourceConfig): CloudWatchLogsClient {
  if (source.credentialProcess) {
    return new CloudWatchLogsClient({ region: source.region, credentials: credentialsFromProcess(source.credentialProcess) });
  }
  return new CloudWatchLogsClient({ region: source.region, profile: source.profile });
}

function insightsString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface FetchResult {
  records: string[];
  warnings: string[];
}

const RESULT_LIMIT = 10000;

export async function fetchCloudWatchSpans(source: CloudWatchSourceConfig, id: string): Promise<FetchResult> {
  const logs = client(source);
  const attribute = source.attribute ?? "session.id";
  const end = Math.floor(Date.now() / 1000);
  const start = end - (source.lookbackDays ?? 30) * 86400;
  const queryString = `filter \`attributes.${attribute}\` = ${insightsString(id)} | fields @message | limit ${RESULT_LIMIT}`;
  let queryId: string | undefined;
  try {
    const started = await logs.send(
      new StartQueryCommand({ logGroupName: source.logGroup ?? "aws/spans", startTime: start, endTime: end, queryString, limit: RESULT_LIMIT }),
    );
    queryId = started.queryId;
  } catch (error) {
    const name = (error as { name?: string }).name ?? "Error";
    const message = (error as Error).message;
    if (/credential|token|expired|signature/i.test(`${name} ${message}`)) {
      throw new SourceError(`AWS credentials for source ${source.name} are missing or expired (${name}). ${source.credentialProcess ? `Check: ${source.credentialProcess}` : "Log in to the profile and retry."}`);
    }
    throw new SourceError(`CloudWatch query failed for source ${source.name}: ${name}: ${message}`);
  }
  if (!queryId) throw new SourceError("CloudWatch did not return a query id");
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((done) => setTimeout(done, attempt < 5 ? 1000 : 2000));
    const result = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (result.status === "Complete") {
      const records = (result.results ?? []).flatMap((row) => row.filter((field) => field.field === "@message").map((field) => field.value ?? ""));
      const warnings = records.length >= RESULT_LIMIT ? [`Hit the ${RESULT_LIMIT} span limit; the conversation may be incomplete.`] : [];
      return { records, warnings };
    }
    if (result.status === "Failed" || result.status === "Cancelled" || result.status === "Timeout") {
      throw new SourceError(`CloudWatch query ${result.status?.toLowerCase()}`);
    }
  }
  throw new SourceError("CloudWatch query did not finish in time");
}
