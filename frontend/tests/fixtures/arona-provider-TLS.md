# Local Arona browser-test TLS fixture

`arona-provider-ca.pem`, `arona-provider-cert.pem`, and `arona-provider-key.pem`
are **public, test-only certificate/key material** for the controllable provider in
`tests/e2e/tcy/arona-steering.spec.ts`. They are not application credentials.
The server certificate covers only `127.0.0.1` and `localhost`, and the test server
listens only on `127.0.0.1` at an ephemeral port. The signing CA private key was
discarded after generating the server certificate.

Run through the repository Mage task with the public CA trusted by its isolated
API process and the explicit existing loopback outgoing-request opt-in:

```sh
SSL_CERT_FILE="$PWD/frontend/tests/fixtures/arona-provider-ca.pem" \
VIKUNJA_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS=true \
mage test:e2e "tests/e2e/tcy/arona-steering.spec.ts"
```

The spec skips with an explicit reason unless both environment settings are
present. It never disables certificate verification, changes the production SSRF
policy, or uses a paid/external model service. Do not install this CA on a normal
browser or production server, and never reuse the public fixture key for a real
service.
