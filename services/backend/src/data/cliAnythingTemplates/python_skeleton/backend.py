import os
import shutil
import subprocess

def find_exe(name):
    """Find the executable for the target software."""
    path = shutil.which(name)
    if path:
        return path
    common_paths = [
        f'/usr/local/bin/{name}',
        f'/usr/bin/{name}',
        f'/opt/{name}/bin/{name}',
        os.path.expanduser(f'~/.local/bin/{name}'),
    ]
    for p in common_paths:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    env_var = f'{name.upper()}_PATH'
    if os.environ.get(env_var):
        return os.environ[env_var]
    return None

def run_command(args, timeout=60, cwd=None):
    """Run a subprocess command and return structured result."""
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
        )
        return {
            'success': result.returncode == 0,
            'stdout': result.stdout,
            'stderr': result.stderr,
            'returncode': result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {'success': False, 'error': f'Command timed out after {timeout}s'}
    except FileNotFoundError:
        return {'success': False, 'error': f'Executable not found: {args[0]}'}
    except Exception as e:
        return {'success': False, 'error': str(e)}
