FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ curl_cffi==0.16.0

COPY fetchd.py /app/fetchd.py

EXPOSE 7899
CMD ["python3", "/app/fetchd.py"]
