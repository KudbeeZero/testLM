$policyArns = @(
    "arn:aws:iam::aws:policy/AlexaForBusinessGatewayExecution",
    "arn:aws:iam::aws:policy/AlexaForBusinessDeviceSetup",
    "arn:aws:iam::aws:policy/AdministratorAccess-AWSElasticsBeanstalk",
    "arn:aws:iam::aws:policy/AIOpsOperatorAccess",
    "arn:aws:iam::aws:policy/AIOpsAssistantPolicy",
    "arn:aws:iam::aws:policy/AIDevOpsAgentActionsPolicy",
    "arn:aws:iam::aws:policy/AIDevOpsOperatorAppAccessPolicy",
    "arn:aws:iam::aws:policy/AIOpsAssistantIncidentReportPolicy",
    "arn:aws:iam::aws:policy/AIDevOpsAgentReadOnlyAccess",
    "arn:aws:iam::aws:policy/AdministratorAccess-Amplify",
    "arn:aws:iam::aws:policy/AIDevOpsAgentAccessPolicy",
    "arn:aws:iam::aws:policy/AIOpsReadOnlyAccess",
    "arn:aws:iam::aws:policy/AgentRegistryReadOnlyAccess",
    "arn:aws:iam::aws:policy/AccountManagementFromVerce",
    "arn:aws:iam::aws:policy/service-role/AIDevOpsConstellationAccessPolicy"
)

$results = @()

foreach ($arn in $policyArns) {
    $policyName = $arn.Split("/")[-1]
    Write-Host "Getting policy: $policyName" -ForegroundColor Cyan
    
    try {
        $policy = aws iam get-policy --policy-arn $arn --output json 2>&1 | ConvertFrom-Json
        $defaultVersionId = $policy.Policy.DefaultVersionId
        
        $policyVersion = aws iam get-policy-version --policy-arn $arn --version-id $defaultVersionId --output json 2>&1 | ConvertFrom-Json
        
        $result = @{
            PolicyName = $policyName
            Arn = $arn
            DefaultVersionId = $defaultVersionId
            AttachmentCount = $policy.Policy.AttachmentCount
            PolicyVersion = $policyVersion
        }
        $results += $result
        
        # Save individual detail
        $policyVersion | ConvertTo-Json -Depth 10 | Out-File -FilePath "c:\Users\domin\Downloads\testLM\details\$policyName.json" -Encoding utf8
        
        Write-Host "  Saved: $policyName" -ForegroundColor Green
    }
    catch {
        Write-Host "  ERROR: $policyName - $($_.Exception.Message)" -ForegroundColor Red
    }
}

$results | ConvertTo-Json -Depth 10 | Out-File -FilePath c:\Users\domin\Downloads\testLM\all-policies-detail.json -Encoding utf8
Write-Host "`nAll policy details saved to all-policies-detail.json" -ForegroundColor Yellow