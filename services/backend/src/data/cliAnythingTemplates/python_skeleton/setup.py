from setuptools import setup, find_namespace_packages

setup(
    name='cli-anything-{{SOFTWARE}}',
    version='1.0.0',
    description='CLI-Anything agent tool for {{SOFTWARE}}',
    packages=find_namespace_packages(include=['cli_anything.*']),
    entry_points={
        'console_scripts': [
            'cli-anything-{{SOFTWARE}}=cli_anything.{{SOFTWARE}}.{{SOFTWARE}}_cli:cli',
        ],
    },
    install_requires=['click>=8.0'],
    python_requires='>=3.8',
)
