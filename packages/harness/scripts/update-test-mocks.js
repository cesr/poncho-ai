#!/usr/bin/env node
/**
 * Script to update harness tests from old modelClient mocks to new Vercel AI SDK mocks
 *
 * This script removes old mock injection patterns and updates assertion patterns.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const testFilePath = join(process.cwd(), 'test/harness.test.ts');
let content = readFileSync(testFilePath, 'utf8');

// Pattern 1: Remove simple mock generation and injection
// Matches: const mockedGenerate = vi.fn().mockResolvedValueOnce({...});
// Followed by: (harness as unknown as { modelClient: { generate: unknown } }).modelClient = { generate: mockedGenerate };
const simpleMockPattern = /const mockedGenerate = vi\.fn\(\)\.mockResolvedValueOnce\(\{[^}]+text: "([^"]+)",[^}]+toolCalls: \[\],[^}]+usage: \{ input: (\d+), output: (\d+) \},[^}]+\}\);[\s\n]+(\/\/[^\n]+\n)*\s*\([\w\s]+as unknown as \{ modelClient: \{ generate: unknown \} \}\)\.modelClient = \{[\s\n]+generate: mockedGenerate,[\s\n]+\};/g;

// Replace with nothing (use default mock from beforeEach)
content = content.replace(simpleMockPattern, '// Uses default mock from beforeEach\n');

// Pattern 2: Update assertion patterns
// Change: const firstCall = mockedGenerate.mock.calls[0]?.[0] as ... { systemPrompt?: string; ...}
// To: const firstCall = mockStreamText.mock.calls[0]?.[0] as ... { system?: string; ...}
content = content.replace(/mockedGenerate\.mock\.calls/g, 'mockStreamText.mock.calls');
content = content.replace(/systemPrompt\?:/g, 'system?:');
content = content.replace(/firstCall\?\.systemPrompt/g, 'firstCall?.system');

// Pattern 3: Update tool assertion patterns
// Change: const toolNames = firstCall?.tools?.map((t) => t.name) ?? [];
// To: const toolNames = Object.keys(firstCall?.tools ?? {});
content = content.replace(
  /const toolNames = firstCall\?\.tools\?\.map\(\(t\) => t\.name\) \?\? \[\];/g,
  'const toolNames = Object.keys(firstCall?.tools ?? {});'
);

// Pattern 4: Remove generateStream mock injections (similar to generate)
content = content.replace(
  /\([\w\s]+as unknown as \{ modelClient: \{ generateStream: unknown \} \}\)\.modelClient = \{[\s\n]+generateStream: [^}]+\};/g,
  '// Uses default mock from beforeEach\n'
);

writeFileSync(testFilePath, content, 'utf8');

console.log('✅ Updated test file');
console.log('📝 Manual updates still needed for:');
console.log('   - Tests with multiple mockResolvedValueOnce calls (sequences)');
console.log('   - Tests with custom tool calls');
console.log('   - Tests checking specific model parameters');
