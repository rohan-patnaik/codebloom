package main

import (
	"fmt"
)

type Server struct {
	name string
}

func (s *Server) Start() {
	fmt.Println(s.name)
}

func main() {
	s := &Server{name: "a"}
	s.Start()
}
