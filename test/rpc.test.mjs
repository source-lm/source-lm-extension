import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './helpers.mjs';

const { parseBatchExecute, extractRpcError } = await bundle('content/rpc');

test('rpc: parseBatchExecute strips anti-XSSI prefix and parses chunks of varying length', () => {
  const chunkA = JSON.stringify(['wrb.fr', 'rpcId1', '["ok"]', null, null, null, 'generic']);
  const chunkB = JSON.stringify(['di', 12]);
  const raw = `)]}'\n${chunkA.length}\n${chunkA}\n${chunkB.length}\n${chunkB}\n`;

  const chunks = parseBatchExecute(raw);

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], ['wrb.fr', 'rpcId1', '["ok"]', null, null, null, 'generic']);
  assert.deepEqual(chunks[1], ['di', 12]);
});

test('rpc: extractRpcError reads error code 3 (INVALID_ARGUMENT) from an HTTP-200 payload', () => {
  // Shape mirrors errors.py: ["wrb.fr", rpcId, result, ..., errorPayload, "generic"]
  // errorPayload = [code, null, [[detailTypeUrl, detailData]]]
  const item = [
    'wrb.fr',
    'someRpcId',
    null,
    null,
    null,
    [3, null, [['type.googleapis.com/some.DeepResearchErrorDetail', [4]]]],
    'generic',
  ];

  const error = extractRpcError(item);

  assert.ok(error);
  assert.equal(error.code, 3);
  assert.match(error.message, /code 3/);
});

test('rpc: extractRpcError returns null when the response has no error payload', () => {
  const item = ['wrb.fr', 'someRpcId', '["result value"]', null, null, null, 'generic'];

  assert.equal(extractRpcError(item), null);
});
