#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成开发用的自签名 HTTPS 证书（含 localhost / 127.0.0.1 / 局域网 IP 的 SAN）。

为什么需要：iOS Safari 与 Android Chrome 只在安全上下文（https 或 localhost）里
开放 getUserMedia，而手机访问电脑上的 dev server 必须走 https。

用法：
    python scripts/gen-cert.py
输出：
    certs/dev-cert.pem / certs/dev-key.pem   （已被 .gitignore 忽略）
提示：
    手机首次访问会提示"证书不受信任"，选择"继续访问"即可（开发场景足够）。
"""

import datetime
import ipaddress
import os
import socket
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "certs")
CERT_PATH = os.path.join(OUT_DIR, "dev-cert.pem")
KEY_PATH = os.path.join(OUT_DIR, "dev-key.pem")


def local_ips():
    ips = set()
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ips.add(info[4][0])
    except Exception:
        pass
    # 默认路由探测（不会真的发包）
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    return sorted(i for i in ips if not i.startswith("127."))


def build():
    os.makedirs(OUT_DIR, exist_ok=True)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "CN"),
            x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "Henan"),
            x509.NameAttribute(NameOID.LOCALITY_NAME, "Xunxian"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Gugu Adventure Dev"),
            x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
        ]
    )

    alt = [
        x509.DNSName("localhost"),
        x509.DNSName("*.localhost"),
        x509.DNSName("*.local"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
        x509.IPAddress(ipaddress.ip_address("::1")),
    ]
    for ip in local_ips():
        try:
            alt.append(x509.IPAddress(ipaddress.ip_address(ip)))
        except ValueError:
            pass

    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(alt), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    with open(KEY_PATH, "wb") as f:
        f.write(
            key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
    with open(CERT_PATH, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

    print("已生成自签名证书：")
    print("  " + CERT_PATH)
    print("  " + KEY_PATH)
    print("SAN: " + ", ".join(str(a.value) for a in alt))


if __name__ == "__main__":
    try:
        build()
    except ImportError:
        sys.stderr.write("需要 python 包 cryptography：D:/python/python.exe -m pip install cryptography\n")
        sys.exit(1)
