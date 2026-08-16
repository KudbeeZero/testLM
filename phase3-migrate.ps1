$ErrorActionPreference = "Continue"

Write-Host "=== PHASE 3: MIGRATE INSTANCES TO NEW PROFILE ==="

# Instance association IDs from snapshot:
# i-0a8157bc8ea33b36b: iip-assoc-06b769501862391ce
# i-0685561c90845986d: iip-assoc-068248cde6768ebaa

Write-Host "Replacing profile for instance 1..."
aws ec2 replace-iam-instance-profile-association --iam-instance-profile Name=EC2-SSM-MINIMAL --association-id iip-assoc-06b769501862391ce --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\phase3-instance1.json"

Write-Host "Replacing profile for instance 2..."
aws ec2 replace-iam-instance-profile-association --iam-instance-profile Name=EC2-SSM-MINIMAL --association-id iip-assoc-068248cde6768ebaa --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\phase3-instance2.json"

Write-Host "Verifying instance 1 new profile..."
aws ec2 describe-iam-instance-profile-associations --filters Name=association-id,Values=iip-assoc-06b769501862391ce --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\phase3-verify1.json"

Write-Host "Verifying instance 2 new profile..."
aws ec2 describe-iam-instance-profile-associations --filters Name=association-id,Values=iip-assoc-068248cde6768ebaa --output json | Tee-Object -FilePath "c:\Users\domin\Downloads\testLM\phase3-verify2.json"

Write-Host "=== PHASE 3 COMPLETE ==="
