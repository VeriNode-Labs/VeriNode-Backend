import { PreflightAnalyzer } from '../../src/blockchain/preflight_analyzer';
import { RpcClient, SimulateTransactionResponse, ContractOperation } from '../../src/blockchain/rpc_client';
import { TTL_EXTENSION_INSTRUCTIONS } from '../../src/contracts/verification_contract';

class MockRpcClient extends RpcClient {
  public mockResponse: SimulateTransactionResponse = {
    latestLedger: '1000',
    cost: {
      instructions: '1000000',
      read_bytes: '1000',
      write_bytes: '1000',
    }
  };

  constructor() {
    super({ endpoint: 'http://localhost:8000', timeoutMs: 5000 });
  }

  async simulateTransaction(tx: string): Promise<SimulateTransactionResponse> {
    return this.mockResponse;
  }
}

async function testPreflightBufferCalculation() {
  const mockRpc = new MockRpcClient();
  const analyzer = new PreflightAnalyzer(mockRpc);

  const operation: ContractOperation = {
    contractId: 'test_contract',
    functionName: 'test_function',
    args: ['test_arg'],
  };

  // Base instructions: 1,000,000
  // Buffer: 1,000,000 * 1.5 + 50,000 = 1,550,000
  // Storage overhead: 5 keys * 5000 = 25,000
  // Total expected: 1,575,000

  const report = await analyzer.analyze(operation);

  const expectedBuffer = Math.floor(1000000 * 1.5) + 50000 + (5 * TTL_EXTENSION_INSTRUCTIONS);

  console.log(`Instructions: ${report.instructions}`);
  console.log(`Estimated Gas: ${report.estimatedGas}`);
  console.log(`Expected Buffer: ${expectedBuffer}`);

  if (report.estimatedGas === expectedBuffer) {
    console.log('✓ Buffer calculation is correct');
  } else {
    console.error(`✗ Buffer calculation is incorrect. Expected ${expectedBuffer}, got ${report.estimatedGas}`);
    process.exit(1);
  }

  const ratio = report.estimatedGas / report.instructions;
  if (ratio >= 1.4 && ratio <= 1.6) {
    console.log(`✓ Ratio ${ratio.toFixed(2)} is within 1.4x - 1.6x range`);
  } else {
    console.error(`✗ Ratio ${ratio.toFixed(2)} is NOT within 1.4x - 1.6x range`);
    process.exit(1);
  }
}

async function testPreflightCaching() {
  const mockRpc = new MockRpcClient();
  const analyzer = new PreflightAnalyzer(mockRpc);
  const operation: ContractOperation = {
    contractId: 'test_contract',
    functionName: 'test_function',
    args: ['test_arg'],
  };

  const report1 = await analyzer.analyze(operation);

  // Change mock response to see if cache is used
  mockRpc.mockResponse = {
    latestLedger: '1001',
    cost: {
      instructions: '2000000',
      read_bytes: '2000',
      write_bytes: '2000',
    }
  };

  const report2 = await analyzer.analyze(operation);

  if (report1.estimatedGas === report2.estimatedGas) {
    console.log('✓ Caching is working');
  } else {
    console.error('✗ Caching failed');
    process.exit(1);
  }
}

async function runTests() {
  console.log('Running PreflightAnalyzer tests...');
  try {
    await testPreflightBufferCalculation();
    await testPreflightCaching();
    console.log('All PreflightAnalyzer tests passed!');
  } catch (err) {
    console.error('Tests failed:', err);
    process.exit(1);
  }
}

runTests();
