# Pre-configured Asterisk bundle
Exact configuration deployed on the reference PBX (Asterisk 18.10.0~dfsg+~cs6.10.40431411-2, 192.168.100.85).
Deploy with:  `sudo bash install-bundle.sh <extracted-dir> /etc/asterisk /usr/share/asterisk/sounds`
Then: `asterisk -rx "core restart now"`
NOTE: contains live SIP/AMI secrets — keep in the private repo/release only.
