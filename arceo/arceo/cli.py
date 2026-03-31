"""CLI: arceo scan — runs Arceo simulation on agent code."""

from __future__ import annotations

import sys

try:
    import click
except ImportError:
    # Minimal fallback if click not installed
    class click:
        @staticmethod
        def command(*a, **k):
            def d(f): return f
            return d
        @staticmethod
        def option(*a, **k):
            def d(f): return f
            return d
        @staticmethod
        def group(*a, **k):
            def d(f): return f
            return d


from arceo.config import load_config
from arceo.scanner import scan_all
from arceo.ci import format_results, format_github_comment, get_exit_code


@click.group()
def cli():
    """Arceo — AI agent risk scanner."""
    pass


@cli.command()
@click.option("--config", "-c", default="arceo.yaml", help="Path to arceo.yaml config file")
@click.option("--verbose", "-v", is_flag=True, help="Show detailed output")
@click.option("--format", "output_format", type=click.Choice(["text", "github"]), default="text", help="Output format")
@click.option("--url", default=None, help="Override Arceo backend URL")
def scan(config, verbose, output_format, url):
    """Scan all agents defined in arceo.yaml against policy thresholds."""
    try:
        cfg = load_config(config)
    except FileNotFoundError:
        click.echo(f"Error: Config file '{config}' not found.", err=True)
        click.echo("Create an arceo.yaml file. See: https://github.com/Nikhilrangaa/ActionGate", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Error loading config: {e}", err=True)
        sys.exit(1)

    if url:
        cfg.arceo_url = url

    if not cfg.agents:
        click.echo("No agents defined in config.", err=True)
        sys.exit(1)

    click.echo(f"Scanning {len(cfg.agents)} agent(s)...")

    results = scan_all(cfg)

    if output_format == "github":
        click.echo(format_github_comment(results))
    else:
        click.echo(format_results(results, verbose=verbose))

    sys.exit(get_exit_code(results))


def main():
    cli()


if __name__ == "__main__":
    main()
