import * as fs from 'fs';
import * as path from 'path';
import { flattenConfig, computeHashFromFlattened } from './flatten';

export interface BaselineConfigSource {
  name: string;
  /**
   * Load baseline config object (committed source).
   */
  loadBaseline(): Promise<unknown>;
}

export class ExampleConfigBaselineSource implements BaselineConfigSource {
  name = 'repo:config.json.example';
  constructor(
    private readonly examplePath: string = path.resolve(__dirname, '../../../config.json.example'),
  ) {}

  async loadBaseline(): Promise<unknown> {
    const content = fs.readFileSync(this.examplePath, 'utf8');
    return JSON.parse(content);
  }
}

export interface BaselineSnapshot {
  sourceName: string;
  baselineConfig: unknown;
  flattened: Record<string, string>;
  baselineHash: string;
}

export async function loadBaselineSnapshot(sources: BaselineConfigSource[]): Promise<BaselineSnapshot> {
  const source = sources[0];
  if (!source) throw new Error('No baseline sources configured');
  const baselineConfig = await source.loadBaseline();
  const flattened = flattenConfig(baselineConfig);
  const baselineHash = computeHashFromFlattened(flattened);
  return { sourceName: source.name, baselineConfig, flattened, baselineHash };
}

