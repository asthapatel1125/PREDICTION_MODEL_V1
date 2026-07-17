import uvicorn

from axiom.config.schema import PlatformSettings


def main()->None:
    settings=PlatformSettings();uvicorn.run("axiom.api.app:app",host=settings.api_host,port=settings.api_port,reload=settings.environment=="development")


if __name__=="__main__":main()
