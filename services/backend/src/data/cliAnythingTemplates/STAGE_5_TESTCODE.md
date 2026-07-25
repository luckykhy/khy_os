# Stage 5: Test Implementation

## Objective
Implement test code based on the test plan from Stage 4.

## Inputs
- `TEST.md` from Stage 4
- Source code from Stage 3

## Python Tests

Generate test files at `tests/`:
```python
# tests/test_<command_group>.py
import pytest
from unittest.mock import patch, MagicMock
from click.testing import CliRunner
from cli_anything.<SOFTWARE>.<SOFTWARE>_cli import cli

@pytest.fixture
def runner():
    return CliRunner()

class TestProjectCommands:
    def test_create_project(self, runner):
        result = runner.invoke(cli, ['project', 'create', '--name', 'test'])
        assert result.exit_code == 0

    def test_create_project_json(self, runner):
        result = runner.invoke(cli, ['project', 'create', '--name', 'test', '--json'])
        data = json.loads(result.output)
        assert data['status'] == 'success'

    @patch('cli_anything.<SOFTWARE>.utils.backend.run_command')
    def test_backend_called(self, mock_run, runner):
        mock_run.return_value = MagicMock(returncode=0, stdout='ok')
        result = runner.invoke(cli, ['export', 'render'])
        mock_run.assert_called_once()
```

## Node.js Tests

Generate test files at `tests/`:
```javascript
// tests/<command_group>.test.js
const { execFileSync } = require('child_process');
const path = require('path');
const CLI = path.resolve(__dirname, '../src/index.js');

describe('<command_group>', () => {
  test('create project', () => {
    const out = execFileSync('node', [CLI, 'project', 'create', '--name', 'test'], { encoding: 'utf-8' });
    expect(out).toContain('Created');
  });

  test('create project --json', () => {
    const out = execFileSync('node', [CLI, 'project', 'create', '--name', 'test', '--json'], { encoding: 'utf-8' });
    const data = JSON.parse(out);
    expect(data.status).toBe('success');
  });
});
```

## Output
- `tests/` directory with all test files
- Updated `TEST.md` (Part 1 checked off where implemented)
