from setuptools import setup, find_packages

setup(
    name="arceo",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        "httpx>=0.27.0",
        "click>=8.0",
        "pyyaml>=6.0",
    ],
    entry_points={
        "console_scripts": [
            "arceo=arceo.cli:main",
        ],
    },
    description="Monitor any AI agent's tool calls and get a risk report.",
    author="Arceo",
    python_requires=">=3.9",
)
