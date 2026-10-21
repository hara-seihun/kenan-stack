import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
// Execute the maintained person-construction expression, rather than configuring a real host.
test('work operator receives host conditions; employees keep their own inbox scope', () => {
 const code = `import ast\ns=ast.parse(open('deploy/configure.py').read())\nc=next(n for n in ast.walk(s) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='dict' and any(k.arg=='alertDir' for k in n.keywords))\ne=next(k.value for k in c.keywords if k.arg=='alertDir')\nfor i in ['acme','e-other']:\n print(eval(compile(ast.Expression(e),'<alertDir>','eval')))\n`;
 expect(execFileSync('python3', ['-c', code], {encoding:'utf8'}).trim().split('\n')).toEqual(['/var/lib/machine-alerts/inbox','None']);
});
