from setuptools import setup, find_packages

setup(
    name="actiongate",
    version="0.1.0",
    packages=find_packages(),
    install_requires=["httpx>=0.27.0"],
    description="ActionGate SDK — test your AI agent's tools in a sandbox",
    python_requires=">=3.9",
)
