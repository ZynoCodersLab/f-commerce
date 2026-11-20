// @vitest-environment node
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const frontendDir = import.meta.dirname;
const repoRoot = path.resolve(frontendDir, '..');

describe('frontend ESLint configuration', () => {
  it('resolves react-hooks rules when ESLint runs from the repository root', async () => {
    const eslint = new ESLint({ cwd: repoRoot });

    const results = await eslint.lintFiles([
      'frontend/src/app/invite/[token]/page.tsx',
      'frontend/src/app/onboarding/page.tsx',
      'frontend/src/app/settings/team/page.tsx',
    ]);

    const errors = results.flatMap((result) =>
      result.messages.filter((message) => message.severity === 2),
    );
    expect(errors).toEqual([]);
  }, 30_000);

  it('enforces react-hooks/set-state-in-effect for frontend files from both roots', async () => {
    const sample = [
      "import { useEffect, useState } from 'react';",
      'export function Demo() {',
      '  const [count, setCount] = useState(0);',
      '  useEffect(() => {',
      '    setCount(1);',
      '  }, []);',
      '  return count;',
      '}',
      '',
    ].join('\n');

    const rootLinter = new ESLint({ cwd: repoRoot });
    const [rootResult] = await rootLinter.lintText(sample, {
      filePath: path.join(frontendDir, 'src/demo-regression.tsx'),
    });
    expect(rootResult.messages.map((message) => message.ruleId)).toContain(
      'react-hooks/set-state-in-effect',
    );

    const workspaceLinter = new ESLint({ cwd: frontendDir });
    const [workspaceResult] = await workspaceLinter.lintText(sample, {
      filePath: path.join(frontendDir, 'src/demo-regression.tsx'),
    });
    expect(workspaceResult.messages.map((message) => message.ruleId)).toContain(
      'react-hooks/set-state-in-effect',
    );
  }, 30_000);
});
