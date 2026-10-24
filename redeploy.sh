docker stack rm comfy-orchestrator

sleep 4

docker stack deploy -c docker-compose.yml --with-registry-auth comfy-orchestrator
