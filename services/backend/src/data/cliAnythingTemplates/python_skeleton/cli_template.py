import click
import json
import sys

@click.group()
@click.version_option(version='1.0.0')
@click.pass_context
def cli(ctx):
    """cli-anything-{{SOFTWARE}} — AI agent control for {{SOFTWARE}}."""
    ctx.ensure_object(dict)

@cli.group()
@click.pass_context
def project(ctx):
    """Project management commands."""
    pass

@project.command('create')
@click.option('--name', required=True, help='Project name')
@click.option('--json', 'as_json', is_flag=True, help='JSON output')
@click.pass_context
def project_create(ctx, name, as_json):
    """Create a new project."""
    result = {'status': 'success', 'command': 'project.create', 'data': {'name': name}}
    if as_json:
        click.echo(json.dumps(result))
    else:
        click.echo(f'Created project: {name}')

@cli.group()
@click.pass_context
def session(ctx):
    """Session management (undo/redo)."""
    pass

@session.command('undo')
@click.option('--json', 'as_json', is_flag=True)
@click.pass_context
def session_undo(ctx, as_json):
    """Undo the last operation."""
    from cli_anything.{{SOFTWARE}}.core.session import SessionManager
    mgr = SessionManager.get_current()
    result = mgr.undo()
    if as_json:
        click.echo(json.dumps(result))
    else:
        click.echo(f'Undo: {result.get("message", "done")}')

@session.command('redo')
@click.option('--json', 'as_json', is_flag=True)
@click.pass_context
def session_redo(ctx, as_json):
    """Redo the last undone operation."""
    from cli_anything.{{SOFTWARE}}.core.session import SessionManager
    mgr = SessionManager.get_current()
    result = mgr.redo()
    if as_json:
        click.echo(json.dumps(result))
    else:
        click.echo(f'Redo: {result.get("message", "done")}')

if __name__ == '__main__':
    cli()
